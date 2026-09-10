/**
 * Relay link from hermes-relay — reach the daemon from outside the LAN.
 *
 * The daemon connects OUT to a relay (a small TCP pub/sub server, see
 * relay_server.js), subscribes to a channel, and publishes/direct-messages
 * over it. A phone that joins the same channel on the same relay can talk to
 * this daemon without any inbound port on the PC. The daemon can also HOST a
 * relay itself (RH_RELAY_PORT) so a LAN peer can relay through it.
 *
 * Auto-reconnect (backoff logic salvaged from websocket_reconnect_client.js —
 * client-kt exponential-with-jitter pattern): the link dials OUT, so it is the
 * single thing holding the off-LAN lifeline up — it must survive relay
 * restarts and network blips without a human. Manual disconnect() never
 * reconnects; failures retry forever with capped exponential backoff by
 * default (configurable via `reconnect`).
 *
 * Events emitted via the onEvent callback:
 *   { type: "relay_state", state, url?, channel?, message? }  — connecting/connected/disconnected/error/reconnecting/failed
 *   { type: "relay_message", channel, data, from }            — a peer published on our channel
 *   { type: "relay_host", state, port? }                      — hosting started/stopped
 */
import net from "node:net";
import os from "node:os";
import { RelayServer } from "./relay_server.js";

export function createRelayLink({ onEvent = () => {}, reconnect = {} } = {}) {
  const maxRetries = reconnect.maxRetries ?? Infinity; // daemon default: keep trying
  const baseDelay = reconnect.baseDelay ?? 1000;
  const maxDelayMs = reconnect.maxDelay ?? 30000;
  const jitter = reconnect.jitter !== false;

  let socket = null;
  let connId = null;
  let channel = null;
  let url = null;
  let intentToClose = false;
  let hostServer = null;
  let lastTarget = null; // { url, channel } — what auto-reconnect dials
  let retryCount = 0;
  let reconnectTimer = null;

  function emit(evt) {
    try {
      onEvent(evt);
    } catch {
      /* listener errors must not kill the link */
    }
  }

  function defaultChannel() {
    return `rh-${os.hostname().toLowerCase()}`;
  }

  /** Normalize `relay://host:port` / `host:port` → host, port. */
  function parseUrl(target) {
    const cleaned = String(target).replace(/^relay:\/\//, "").replace(/\/+$/, "");
    const [host, portStr] = cleaned.split(":");
    const port = Number(portStr) || 8790;
    return { host: host || "127.0.0.1", port };
  }

  /**
   * One dial attempt. Does NOT touch retryCount — the backoff counter must
   * survive across internal redials, or the delay never grows (probe-caught).
   * Superseded sockets are guarded by instance identity, not by shared state.
   */
  function dial(targetUrl, targetChannel) {
    if (socket) {
      const stale = socket;
      socket = null;
      try {
        stale.destroy();
      } catch {
        /* already closed */
      }
    }
    connId = null;
    url = targetUrl;
    channel = targetChannel || defaultChannel();
    emit({ type: "relay_state", state: "connecting", url, channel });

    // Capture the socket instance: a superseded socket's async close/error
    // events must not touch the state of a newer connection (classic race —
    // close fires after dial() already swapped in the next socket).
    const sock = net.connect(parseUrl(targetUrl).port, parseUrl(targetUrl).host, () => {
      // Nothing to send yet — wait for the relay's `connected` handshake.
    });
    socket = sock;
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      // Newline-delimited framing (safe: JSON.stringify never emits raw \n).
      // Handles split frames AND several frames in one chunk — the old
      // whole-buffer parse deadlocked forever when two frames coalesced.
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {
            /* malformed frame — skip */
          }
        }
      }
      // Tolerant fallback: a relay that still writes one frame without a
      // trailing newline (old protocol) keeps working.
      if (buf.trim()) {
        try {
          handleMessage(JSON.parse(buf.trim()));
          buf = "";
        } catch {
          /* incomplete frame — wait for more */
        }
      }
    });
    sock.on("close", () => {
      // Only the CURRENT socket may touch state/emit/schedule — a superseded
      // socket's late close must stay silent (the new connection manages itself).
      if (socket !== sock) return;
      socket = null;
      connId = null;
      if (!intentToClose) {
        emit({ type: "relay_state", state: "disconnected", url, channel, message: "relay link closed" });
        scheduleReconnect("link closed");
      }
    });
    sock.on("error", (err) => {
      if (socket !== sock) return;
      socket = null;
      connId = null;
      if (!intentToClose) {
        emit({ type: "relay_state", state: "error", url, channel, message: err.message });
        scheduleReconnect(err.message);
      }
    });
  }

  /** Public connect: fresh intent, backoff reset, remembers target for reconnect. */
  function connect(targetUrl, targetChannel) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    intentToClose = false;
    retryCount = 0;
    lastTarget = { url: targetUrl, channel: targetChannel || defaultChannel() };
    dial(targetUrl, targetChannel);
  }

  function handleMessage(msg) {
    if (msg?.type === "connected") {
      connId = msg.id;
      retryCount = 0; // success resets backoff
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      write({ type: "subscribe", channel });
      emit({ type: "relay_state", state: "connected", url, channel, connId });
    } else if (msg?.type === "message") {
      emit({ type: "relay_message", channel: msg.channel, data: msg.data, from: msg.from });
    } else if (msg?.type === "direct") {
      emit({ type: "relay_message", channel, data: msg.data, from: msg.from, direct: true });
    }
  }

  function write(obj) {
    if (socket?.writable) socket.write(JSON.stringify(obj) + "\n");
  }

  /** Publish a payload to every member of our channel (ourselves included). */
  function publish(data) {
    write({ type: "publish", channel, data });
  }

  /** Direct-message one relay peer by its connection id. */
  function sendTo(to, data) {
    write({ type: "direct", to, data });
  }

  /**
   * Exponential backoff with equal jitter (delay/2 + random(0, delay/2)),
   * capped at maxDelayMs — the pattern proven by websocket_reconnect_client.
   */
  function calcDelay() {
    let delay = baseDelay * Math.pow(2, Math.min(retryCount, 16));
    delay = Math.min(delay, maxDelayMs);
    if (jitter) delay = delay / 2 + Math.random() * (delay / 2);
    return Math.round(delay);
  }

  function scheduleReconnect(reason) {
    if (!lastTarget || intentToClose || reconnectTimer) return;
    if (retryCount >= maxRetries) {
      emit({ type: "relay_state", state: "failed", url: lastTarget.url, channel: lastTarget.channel, message: `gave up after ${retryCount} retries (${reason})` });
      return;
    }
    const delay = calcDelay();
    retryCount++;
    emit({ type: "relay_state", state: "reconnecting", url: lastTarget.url, channel: lastTarget.channel, attempt: retryCount, delay, message: reason });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Internal redial: dial() only — connect() would reset the backoff.
      if (!intentToClose && lastTarget) dial(lastTarget.url, lastTarget.channel);
    }, delay);
  }

  function disconnect() {
    intentToClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    lastTarget = null; // manual disconnect = no auto-reconnect
    retryCount = 0;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
    }
    socket = null;
    connId = null;
  }

  /** Host a relay on this daemon (LAN peers can relay through us). */
  function host(port) {
    hostStop();
    hostServer = new RelayServer(port);
    hostServer.on("error", () => {});
    hostServer.start();
    emit({ type: "relay_host", state: "hosting", port });
  }

  function hostStop() {
    if (hostServer) {
      try {
        hostServer.stop();
      } catch {
        /* already stopped */
      }
    }
    hostServer = null;
    emit({ type: "relay_host", state: "stopped" });
  }

  function status() {
    return {
      connected: !!socket && connId !== null,
      url,
      channel,
      connId,
      hosting: !!hostServer,
      hostPort: hostServer?.port ?? null,
      reconnecting: reconnectTimer !== null,
      retryCount,
    };
  }

  function dispose() {
    disconnect();
    hostStop();
  }

  return { connect, disconnect, publish, sendTo, host, hostStop, status, dispose, defaultChannel };
}
