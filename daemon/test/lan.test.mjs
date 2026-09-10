// LAN file transfer absorption test — exercises the lan_* protocol surface
// (lanlink inspiration, LocalSend v2 protocol). A real file is pushed over
// HTTP to an in-process FileTransferServer and verified byte-for-byte;
// discovery answers with shape (never asserts on real-LAN peer contents);
// dead peers and missing files fail gracefully without crashing the daemon.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import path from "node:path";
import fs from "node:fs";

const tmp = makeTmp("rh-t-");
import { FileTransferServer } from "../src/lan_file_transfer.js";

const PORT = 8806;
const TOKEN = "testtoken";
const CLI_PORT = 46806;

// The receiver: a LocalSend v2 server in THIS test process.
const downloads = path.join(tmp, "downloads");
fs.mkdirSync(downloads);
const receiver = new FileTransferServer({ port: 8899, downloadDir: downloads });
receiver.start();

// The file we send.
const sendFile = path.join(tmp, "hello.txt");
fs.writeFileSync(sendFile, "lan-content-42\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Discovery: shape only — the real LAN may legitimately contain LocalSend peers.
  c.send({ type: "lan_peers" });
  const peers = await c.next((m) => m.type === "lan_peers");
  check("lan_peers returns shape", Array.isArray(peers.peers) && Array.isArray(peers.ips) && typeof peers.active === "boolean");

  // Real transfer to the in-process receiver.
  c.send({ type: "lan_send", ip: "127.0.0.1", port: 8899, path: sendFile });
  const sent = await c.next((m) => m.type === "lan_sent");
  check("lan_send completes", sent.ok === true && sent.fileCount === 1 && typeof sent.sessionId === "string");
  await sleep(300); // let the receiver flush
  const received = fs.readFileSync(path.join(downloads, "hello.txt"), "utf8");
  check("receiver got identical bytes", received === "lan-content-42\n");
  check("receiver session marked done", [...receiver.sessions.values()].some((s) => s.status === "done"));

  // Dead peer → graceful failure.
  c.send({ type: "lan_send", ip: "127.0.0.1", port: 9, path: sendFile });
  const dead = await c.next((m) => m.type === "lan_sent");
  check("lan_send to dead peer fails gracefully", dead.ok === false && typeof dead.error === "string");

  // Missing file → graceful failure.
  c.send({ type: "lan_send", ip: "127.0.0.1", port: 8899, path: path.join(tmp, "nope.txt") });
  const missing = await c.next((m) => m.type === "lan_sent");
  check("lan_send missing file fails gracefully", missing.ok === false);

  await c.close();
  receiver.stop();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });