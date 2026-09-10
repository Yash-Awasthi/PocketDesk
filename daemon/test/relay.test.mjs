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
    try {
      const msg = JSON.parse(buf);
      buf = "";
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    } catch { /* partial frame */ }
  });
  await new Promise((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
  const handshake = await peerNext((m) => m.type === "connected", 5000);
  sock.write(JSON.stringify({ type: "subscribe", channel }));
  return {
    id: handshake.id,
    sock,
    send: (o) => sock.write(JSON.stringify(o)),
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

  // Cleanup.
  await c.close();
  relay.stop();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });