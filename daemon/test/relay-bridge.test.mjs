/**
 * Relay bridge — off-LAN access ("kilometers away") without port forwarding.
 *
 * The daemon dials OUT to a relay server (here: its own RH_RELAY_PORT-hosted
 * one, but it can be any host). A remote peer publishes a token-free
 * `rhchallenge`, gets a nonce back direct, and sends every `rhreq` direct to
 * the daemon, the hello carrying an HMAC proof instead of the token; responses
 * and broadcasts come back direct as `rhresp`/`rhpush` envelopes.
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
import crypto from "node:crypto";
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
    direct(to, data) { socket.write(JSON.stringify({ type: "direct", to, data }) + "\n"); },
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

/** Challenge on the channel, then a direct hello carrying a nonce- and connId-bound proof. */
async function relayHello(c, events, token, reqId) {
  const before = events.length;
  c.publish(CHANNEL, { rh: true, type: "rhchallenge" });
  let m = null;
  for (let i = 0; i < 80 && !m; i++) {
    m = events.slice(before).find((e) => e.type === "direct" && e.data?.type === "rhchallenge");
    if (!m) await sleep(25);
  }
  if (!m) return;
  c.daemon = m.from;
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const proof = crypto.createHmac("sha256", key).update(`${m.data.nonce}:${c.id}`).digest("hex");
  c.direct(c.daemon, { rh: true, type: "rhreq", reqId, msg: { type: "hello", proof } });
}

function relayReq(c, reqId, msg) {
  c.direct(c.daemon, { rh: true, type: "rhreq", reqId, msg });
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
  let eavesdropper = null;
  try {
    // Wait for the daemon HTTP + relay to come up.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false);
    }
    check("daemon up with RH_RELAY_PORT", up);

    const pairHtml = await fetch(`http://127.0.0.1:${PORT}/pair`).then((r) => r.text());
    const pair = JSON.parse(Buffer.from(pairHtml.match(/pocketdesk:\/\/pair#([\w-]+)/)[1], "base64url").toString());
    check("pairing QR names the hosted relay and its channel", /^relay:\/\/.+:8898$/.test(pair.r ?? "") && pair.c === CHANNEL);

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
    await relayHello(peer, events, "WRONG", "q0");
    await sleep(600);
    const err = events.find((m) => m?.data?.type === "rherr");
    check("bad token rejected over relay", Boolean(err));
    check("bad-token error mentions token", /token/i.test(err?.data?.error || ""));

    // 4: good token → welcome envelope.
    await relayHello(peer, events, TOKEN, "q1");
    await sleep(600);
    const welcome = events.find((m) => m?.data?.type === "rhresp" && m?.data?.data?.type === "welcome");
    check("hello over relay returns welcome", Boolean(welcome));
    check("welcome carries manifests", Array.isArray(welcome?.data?.data?.manifests) && welcome.data.data.manifests.length >= 1);

    // 5: real protocol command round-trip (fb_status). fbCtrl.status() shells
    // out to tasklist on Windows — allow a generous window for it.
    relayReq(peer, "q2", { type: "fb_status" });
    await sleep(4000);
    const fb = events.find((m) => m?.data?.type === "rhresp" && m?.data?.reqId === "q2" && m?.data?.data?.type === "fb_status");
    check("fb_status round-trips over relay", Boolean(fb));
    check("fb_status has running flag", typeof fb?.data?.data?.running === "boolean");

    // 6: daemon broadcasts are mirrored as rhpush — trigger one via `detect`
    // (registry.scanAll broadcasts a manifests message to every client).
    relayReq(peer, "q3", { type: "detect" });
    await sleep(2500);
    const push = events.find((m) => m?.data?.type === "rhpush" && m?.data?.data?.type === "manifests");
    check("manifests broadcast mirrored to relay peer", Boolean(push));

    // 6b: a peer that only guessed the channel name — the relay itself has no
    // auth — must see nothing. Broadcasts used to be published channel-wide.
    eavesdropper = relayClient(RELAY_PORT, () => {});
    const eavesEvents = [];
    eavesdropper.onMessage((m) => { eavesdropper.grabId(m); eavesEvents.push(m); });
    await sleep(300);
    eavesdropper.sub(CHANNEL);
    await sleep(300);
    relayReq(peer, "q4", { type: "detect" });
    await sleep(2500);
    check("unauthenticated channel member sees no rhpush",
      !eavesEvents.some((m) => m?.data?.type === "rhpush"));
    check("unauthenticated channel member sees no rhresp",
      !eavesEvents.some((m) => m?.data?.type === "rhresp"));

    // 6c: the eavesdropper watches a full hello and never sees the token or the
    // requests, and a proof it could capture is bound to someone else's connId.
    eavesEvents.length = 0;
    const watched = [];
    const watcher = relayClient(RELAY_PORT, () => {});
    watcher.onMessage((m) => { watcher.grabId(m); watched.push(m); });
    await sleep(300);
    watcher.sub(CHANNEL);
    await sleep(300);
    await relayHello(watcher, watched, TOKEN, "watch-hello");
    await sleep(600);
    check("relay hello never puts the token on the channel", !JSON.stringify(eavesEvents).includes(TOKEN));
    check("relay requests are not channel-visible", !eavesEvents.some((m) => m?.data?.type === "rhreq"));
    const sent = { nonce: "stale", proof: "" };
    const nonceMsg = watched.find((m) => m.type === "direct" && m.data?.type === "rhchallenge");
    sent.nonce = nonceMsg?.data?.nonce;
    const key = crypto.createHash("sha256").update(TOKEN).digest("hex");
    sent.proof = crypto.createHmac("sha256", key).update(`${sent.nonce}:${watcher.id}`).digest("hex");
    eavesEvents.length = 0;
    eavesdropper.publish(CHANNEL, { rh: true, type: "rhchallenge" });
    await sleep(300);
    eavesdropper.direct(watcher.daemon, { rh: true, type: "rhreq", reqId: "replay", msg: { type: "hello", proof: sent.proof } });
    await sleep(800);
    check("a proof replayed from another connId is refused",
      !eavesEvents.some((m) => m?.data?.data?.type === "welcome") && eavesEvents.some((m) => m?.data?.type === "rherr"));
    watcher.close();

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
      await relayHello(attacker, attackerEvents, "WRONG", `bad${i}`);
      await sleep(20);
    }
    await sleep(1200);
    const badTokens = attackerEvents.filter((m) => m?.data?.type === "rherr" && /bad token/i.test(m.data.error || ""));
    const throttled = attackerEvents.filter((m) => m?.data?.type === "rherr" && /too many/i.test(m.data.error || ""));
    check("relay rejects bad hellos", badTokens.length > 0);
    check("relay locks a peer out once the failure budget is spent", throttled.length > 0);

    // The lockout must not be defeatable by finally guessing right.
    attackerEvents.length = 0;
    await relayHello(attacker, attackerEvents, TOKEN, "bad-then-good");
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
    await relayHello(innocent, innocentEvents, TOKEN, "good-after");
    await sleep(800);
    check("a second peer is unaffected by the first peer's lockout",
      innocentEvents.some((m) => m?.data?.data?.type === "welcome"));

    // 8: revoking a relay device must cut it off, not just forget it. The shim
    // used to stay subscribed and keep answering requests.
    const innocentId = innocentEvents.find((m) => m?.data?.data?.type === "welcome").data.data.clientId;
    const admin = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const adminMsgs = [];
    admin.on("message", (d) => adminMsgs.push(JSON.parse(d.toString())));
    await new Promise((res, rej) => { admin.on("open", res); admin.on("error", rej); });
    admin.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await sleep(300);
    admin.send(JSON.stringify({ type: "create", harness: "node", cwd: tmpMan }));
    await sleep(1500);
    const term = adminMsgs.find((m) => m.type === "created");
    relayReq(innocent, "attach", { type: "attach", id: term?.id });
    await sleep(800);
    admin.send(JSON.stringify({ type: "device_revoke", clientId: innocentId }));
    await sleep(500);
    check("relay device revoke acks", adminMsgs.some((m) => m.type === "device_revoked" && m.ok));
    innocentEvents.length = 0;
    relayReq(innocent, "after-revoke", { type: "sessions" });
    admin.send(JSON.stringify({ type: "detect" }));
    admin.send(JSON.stringify({ type: "in", id: term?.id, data: Buffer.from("1+1\r").toString("base64") }));
    await sleep(2500);
    check("revoked relay peer gets no more replies", !innocentEvents.some((m) => m?.data?.type === "rhresp"));
    check("revoked relay peer gets no more pushes", !innocentEvents.some((m) => m?.data?.type === "rhpush"));
    admin.close();
  } catch (e) {
    check(`unexpected: ${e.message}`, false);
  } finally {
    peer?.close();
    attacker?.close();
    innocent?.close();
    eavesdropper?.close();
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
