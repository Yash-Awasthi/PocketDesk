import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Relay absorption test — exercises the relay protocol surface (hermes-relay
// inspiration): outbound link to a relay, channel pub/sub bridging to WS
// clients, direct messages, status, disconnect, and daemon-hosted relay.
import net from "node:net";
import { RelayServer } from "../src/relay_server.js";

const tmp = makeTmp("rh-relay-");

const PORT = 8801;
const CLI_PORT = 46801;
const TOKEN = "relaytoken";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw TCP peer on the relay: connect → receive connected handshake → subscribe. */
async function relayPeer(port, channel) {
  const sock = net.connect(port, "127.0.0.1");
  const queue = [];
  const waiters = [];
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    // Newline-terminated framing, as the relay itself uses: one chunk may hold
    // several frames, so parse line by line rather than the whole buffer.
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    }
  });
  await new Promise((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
  const handshake = await peerNext((m) => m.type === "connected", 5000);
  sock.write(JSON.stringify({ type: "subscribe", channel }) + "\n");
  return {
    id: handshake.id,
    sock,
    send: (o) => sock.write(JSON.stringify(o) + "\n"),
    next: (pred, timeoutMs = 15000) => {
      const hit = queue.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting for: " + String(pred).slice(0, 120))), timeoutMs);
        waiters.push({ pred, resolve, timer: t });
      });
    },
    close: () => sock.destroy(),
  };
  function peerNext(pred, timeoutMs) {
    const hit = queue.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for handshake")), timeoutMs);
      waiters.push({ pred, resolve, timer: t });
    });
  }
}

async function main() {
  // ── Phase 1: outbound relay link ──────────────────────────────────────────
  const relay = new RelayServer(8891);
  relay.start();
  await sleep(150);

  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  c.send({ type: "relay_connect", url: "relay://127.0.0.1:8891", channel: "relay-test" });
  const connected = await c.next((m) => m.type === "relay_state" && m.state === "connected");
  check("relay_connect → relay_state connected", connected.channel === "relay-test");

  c.send({ type: "relay_status" });
  const status = await c.next((m) => m.type === "relay_status");
  check("relay_status reports connected link", status.connected === true && status.channel === "relay-test");

  // A phone-side peer joins the same channel on the relay.
  const peer = await relayPeer(8891, "relay-test");
  check("peer handshake + subscribe", typeof peer.id === "string");

  // WS → relay: publish reaches the peer.
  c.send({ type: "relay_publish", data: { hello: "from-phone" } });
  const gotPublish = await peer.next((m) => m.type === "message" && m.channel === "relay-test");
  check("relay_publish reaches channel peer", gotPublish.data?.hello === "from-phone" && typeof gotPublish.from === "string");
  const publishedAck = await c.next((m) => m.type === "relay_published");
  check("relay_publish acked", publishedAck.channel === "relay-test");

  // Relay → WS: peer publish arrives as relay_message. (The daemon also sees
  // its own publishes echoed back — match the peer's payload, not the echo.)
  peer.send({ type: "publish", channel: "relay-test", data: { hello: "from-pc" } });
  const gotMsg = await c.next((m) => m.type === "relay_message" && m.data?.hello === "from-pc");
  check("peer publish → WS relay_message", gotMsg.channel === "relay-test" && typeof gotMsg.from === "string");

  // Direct message: WS → specific peer id.
  c.send({ type: "relay_send", to: peer.id, data: { direct: "hit" } });
  const gotDirect = await peer.next((m) => m.type === "direct" && m.data?.direct === "hit");
  check("relay_send delivers direct message", gotDirect.from !== undefined);

  // Disconnect: link closes, state flips.
  c.send({ type: "relay_disconnect" });
  const ack = await c.next((m) => m.type === "relay_state" && m.state === "disconnected");
  check("relay_disconnect acked", !!ack);
  c.send({ type: "relay_status" });
  // Match the NEW status (the first reply is still in the log with connected:true).
  const afterDisconnect = await c.next((m) => m.type === "relay_status" && m.connected === false);
  check("relay_status after disconnect", afterDisconnect.channel === "relay-test");

  // Missing URL → error state, not a crash.
  c.send({ type: "relay_connect" });
  const noUrl = await c.next((m) => m.type === "relay_state" && m.state === "error");
  check("relay_connect without url errors cleanly", /no relay url/i.test(noUrl.message || ""));

  // ── Phase 2: daemon-hosted relay ──────────────────────────────────────────
  c.send({ type: "relay_host", port: 8892 });
  const hosting = await c.next((m) => m.type === "relay_host" && m.state === "hosting");
  check("relay_host starts embedded relay", hosting.port === 8892);
  const hostPeer = await relayPeer(8892, "hosted-chan");
  check("hosted relay accepts peers", typeof hostPeer.id === "string");

  c.send({ type: "relay_host_stop" });
  const stopped = await c.next((m) => m.type === "relay_host" && m.state === "stopped");
  check("relay_host_stop stops embedded relay", !!stopped);

  // ── Phase 3: framing edge cases ───────────────────────────────────────────
  // The relay's read path has a tolerant fallback for a client that omits the
  // trailing newline. Bytes that do not yet form a complete frame must be kept,
  // not discarded, and a peer that never completes one must be cut off.
  const framer = new RelayServer(8893);
  framer.start();
  await sleep(150);
  const frameSub = await relayPeer(8893, "frame-chan");

  const half = net.connect(8893, "127.0.0.1");
  half.on("error", () => {});
  await new Promise((res, rej) => { half.on("connect", res); half.on("error", rej); });
  await sleep(100);
  const whole = JSON.stringify({ type: "publish", channel: "frame-chan", data: { split: "frame" } });
  // Two writes, no newline: the first is incomplete JSON and must be buffered.
  half.write(whole.slice(0, 20));
  await sleep(150);
  half.write(whole.slice(20));
  const split = await frameSub.next((m) => m.type === "message" && m.data?.split === "frame", 3000);
  check("frame split across two writes is delivered", split.data?.split === "frame");
  half.destroy();

  const flood = net.connect(8893, "127.0.0.1");
  flood.on("error", () => {});
  await new Promise((res, rej) => { flood.on("connect", res); flood.on("error", rej); });
  // More than the 1 MiB cap, and never a complete frame. The assertion is on the
  // relay's own registry, because a peer cut off mid-write does not reliably see
  // the close event on its side.
  flood.write("x".repeat((1 << 20) + 4096));
  await sleep(1200);
  check("peer that never completes a frame is dropped", framer.connections.size === 1);

  // Dropping it must not disturb the peer that frames correctly.
  frameSub.send({ type: "publish", channel: "frame-chan", data: { after: "flood" } });
  const afterFlood = await frameSub.next((m) => m.type === "message" && m.data?.after === "flood", 3000);
  check("well-behaved peer still served after the cap fires", afterFlood.data?.after === "flood");
  flood.destroy();
  framer.stop();

  // Cleanup.
  await c.close();
  relay.stop();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });