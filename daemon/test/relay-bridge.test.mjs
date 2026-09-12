/**
 * Relay bridge — off-LAN access ("kilometers away") without port forwarding.
 *
 * The daemon dials OUT to a relay server (here: its own RH_RELAY_PORT-hosted
 * one, but it can be any host), and remote peers publish `rhreq` envelopes on
 * the daemon's channel. Each envelope carries the daemon token (timing-safe
 * checked, same as the /ws hello) plus one protocol message; responses and
 * broadcasts come back as `rhresp`/`rhpush` envelopes.
 *
 * Covered here:
 *   1. daemon-hosted relay accepts our outbound link (relay_state connected)
 *   2. remote peer connects to the relay over TCP (as it would from another
 *      network), handshakes, subscribes to the daemon's channel
 *   3. bad token is rejected with a `rherr`
 *   4. good token → `welcome` envelope (authenticated relay session)
 *   5. a real protocol command (fb_status) round-trips through the relay
 *   6. daemon broadcasts (manifests from registry scan, relay_state) are
 *      mirrored to the relay peer as `rhpush`
 *   7. repeated bad hellos lock out that peer, and only that peer
 */
import net from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 8812;
// Not 8813: mux.test.mjs runs immediately before this and its daemon binds 8813;
// on Windows a lingering socket made every relay peer connection fail.
const RELAY_PORT = 8898;
const CHANNEL = "rh-relay-test";
const TOKEN = "relay-bridge-token";
const failures = [];
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures.push(name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal relay client mirroring what a phone on another network would run. */
function relayClient(port, onMsg) {
  const socket = net.connect(port, "127.0.0.1");
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString();
    // Newline-terminated framing, same as the daemon's own relay link: one
    // chunk may carry several frames, and a frame may split across chunks.
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onMsg(JSON.parse(line)); } catch { /* ignore malformed frame */ }
    }
  });
  socket.on("error", () => {}); // daemon shutdown resets — ignore
  let id = null;
  const api = {
    get id() { return id; },
    sub(channel) { socket.write(JSON.stringify({ type: "subscribe", channel }) + "\n"); },
    publish(channel, data) { socket.write(JSON.stringify({ type: "publish", channel, data }) + "\n"); },
    close() { socket.destroy(); },
  };
  socket.on("connect", () => {});
  // capture the `connected` handshake id
  const orig = onMsg;
  // (id extraction happens in the caller via msg.id)
  void orig;
  api.onMessage = (fn) => { onMsg = fn; };
  api.grabId = (m) => { if (m?.type === "connected") id = m.id; };
  return api;
}

async function run() {
  const tmpMan = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "rh-relay-"));
  const fs = await import("node:fs");
  fs.writeFileSync(tmpMan + "/node.json", JSON.stringify({ id: "node", name: "Node REPL", adapter: "terminal", bin: "node", install: {} }));

  const daemon = spawn(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    env: {
      ...process.env,
      RH_PORT: String(PORT),
      RH_TOKEN: TOKEN,
      RH_MANIFESTS: tmpMan,
      RH_RELAY_PORT: String(RELAY_PORT),
      RH_RELAY_CHANNEL: CHANNEL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const daemonLogs = { v: "" };
  daemon.stdout.on("data", (d) => (daemonLogs.v += d.toString()));
  daemon.stderr.on("data", (d) => (daemonLogs.v += d.toString()));

  let peer = null;
  let attacker = null;
  let innocent = null;
  try {
    // Wait for the daemon HTTP + relay to come up.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false);
    }
    check("daemon up with RH_RELAY_PORT", up);

    // 1+2: remote peer connects to the relay (TCP) and subscribes.
    const events = [];
    peer = relayClient(RELAY_PORT, () => {});
    peer.onMessage((m) => {
      peer.grabId(m);
      events.push(m);
    });
    await sleep(300);
    peer.sub(CHANNEL);
    await sleep(300);

    // 3: bad token must be rejected.
    peer.publish(CHANNEL, { rh: true, type: "rhreq", reqId: "q0", msg: { type: "hello", token: "WRONG" } });
    await sleep(600);
    const err = events.find((m) => m?.data?.type === "rherr");
    check("bad token rejected over relay", Boolean(err));
    check("bad-token error mentions token", /token/i.test(err?.data?.error || ""));

    // 4: good token → welcome envelope.
    peer.publish(CHANNEL, { rh: true, type: "rhreq", reqId: "q1", msg: { type: "hello", token: TOKEN } });
    await sleep(600);
    const welcome = events.find((m) => m?.data?.type === "rhresp" && m?.data?.data?.type === "welcome");
    check("hello over relay returns welcome", Boolean(welcome));
    check("welcome carries manifests", Array.isArray(welcome?.data?.data?.manifests) && welcome.data.data.manifests.length >= 1);

    // 5: real protocol command round-trip (fb_status). fbCtrl.status() shells
    // out to tasklist on Windows — allow a generous window for it.
    peer.publish(CHANNEL, { rh: true, type: "rhreq", reqId: "q2", msg: { type: "fb_status" } });
    await sleep(4000);
    const fb = events.find((m) => m?.data?.type === "rhresp" && m?.data?.reqId === "q2" && m?.data?.data?.type === "fb_status");
    check("fb_status round-trips over relay", Boolean(fb));
    check("fb_status has running flag", typeof fb?.data?.data?.running === "boolean");

    // 6: daemon broadcasts are mirrored as rhpush — trigger one via `detect`
    // (registry.scanAll broadcasts a manifests message to every client).
    peer.publish(CHANNEL, { rh: true, type: "rhreq", reqId: "q3", msg: { type: "detect" } });
    await sleep(2500);
    const push = events.find((m) => m?.data?.type === "rhpush" && m?.data?.data?.type === "manifests");
    check("manifests broadcast mirrored to relay peer", Boolean(push));

    // Also verify the LAN path still works alongside the relay.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    const lanWelcome = await new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
    check("LAN websocket still authenticates", lanWelcome?.type === "welcome");
    ws.close();

    // 7: the relay is a second door onto the same token, so it needs the same
    // brute-force budget the /ws hello has. One peer exhausting it must not
    // spend that budget for anyone else on the channel.
    attacker = relayClient(RELAY_PORT, () => {});
    const attackerEvents = [];
    attacker.onMessage((m) => { attacker.grabId(m); attackerEvents.push(m); });
    await sleep(300);
    attacker.sub(CHANNEL);
    await sleep(300);
    for (let i = 0; i < 21; i++) {
      attacker.publish(CHANNEL, { rh: true, type: "rhreq", reqId: `bad${i}`, msg: { type: "hello", token: "WRONG" } });
      await sleep(20);
    }
    await sleep(1200);
    const badTokens = attackerEvents.filter((m) => m?.data?.type === "rherr" && /bad token/i.test(m.data.error || ""));
    const throttled = attackerEvents.filter((m) => m?.data?.type === "rherr" && /too many/i.test(m.data.error || ""));
    check("relay rejects bad hellos", badTokens.length > 0);
    check("relay locks a peer out once the failure budget is spent", throttled.length > 0);

    // The lockout must not be defeatable by finally guessing right.
    attackerEvents.length = 0;
    attacker.publish(CHANNEL, { rh: true, type: "rhreq", reqId: "bad-then-good", msg: { type: "hello", token: TOKEN } });
    await sleep(800);
    check("lockout outlives a correct token from the locked-out peer",
      !attackerEvents.some((m) => m?.data?.data?.type === "welcome"));

    // A different peer still gets in — the counter is per peer, not per relay.
    innocent = relayClient(RELAY_PORT, () => {});
    const innocentEvents = [];
    innocent.onMessage((m) => { innocent.grabId(m); innocentEvents.push(m); });
    await sleep(300);
    innocent.sub(CHANNEL);
    await sleep(300);
    innocent.publish(CHANNEL, { rh: true, type: "rhreq", reqId: "good-after", msg: { type: "hello", token: TOKEN } });
    await sleep(800);
    check("a second peer is unaffected by the first peer's lockout",
      innocentEvents.some((m) => m?.data?.data?.type === "welcome"));
  } catch (e) {
    check(`unexpected: ${e.message}`, false);
  } finally {
    peer?.close();
    attacker?.close();
    innocent?.close();
    daemon.kill("SIGTERM");
    await sleep(500);
    daemon.kill("SIGKILL");
  }

  if (failures.length) {
    console.log(`\n${failures.length} FAILURE(S):\n  - ` + failures.join("\n  - "));
    console.log("\n--- daemon log tail ---\n" + daemonLogs.v.split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  console.log("\nALL PASS");
  process.exit(0);
}

run();
