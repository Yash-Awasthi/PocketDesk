// iroh transport end to end, direct-only on loopback: pairing ticket, hello over
// the control stream, device-to-key binding, and GOP-per-stream video.
import { check, finish, makeTmp, startDaemon, teardown } from "./helpers.mjs";
import { IrohSocket, ALPN } from "../src/iroh_link.js";

let iroh;
try { iroh = await import("@number0/iroh"); } catch {
  console.log("SKIP  @number0/iroh not installed");
  process.exit(0);
}
const { Endpoint, RelayMode, EndpointTicket } = iroh;

const PORT = 8841;
const CLI_PORT = 46841;
const TOKEN = "irohtoken";
const alpn = [...Buffer.from(ALPN)];
const keep = [];

async function endpoint(alpns = []) {
  const b = Endpoint.builder();
  b.applyMinimal();
  b.relayMode(RelayMode.disabled());
  b.alpns(alpns);
  const ep = await b.bind();
  keep.push(ep);
  return ep;
}

const frame = (buf) => { const b = Buffer.alloc(4 + buf.length); b.writeUInt32BE(buf.length, 0); buf.copy(b, 4); return b; };
async function readMsg(recv) {
  const len = Buffer.from(await recv.readExact(4)).readUInt32BE(0);
  return Buffer.from(await recv.readExact(len));
}

/** Dials the daemon and sends a hello; resolves the first reply, or "closed". */
async function dialAndHello(ticket, hello) {
  const ep = await endpoint();
  const conn = await ep.connect(EndpointTicket.fromString(ticket).endpointAddr(), alpn);
  const bi = await conn.openBi();
  await bi.send.writeAll([...frame(Buffer.from(JSON.stringify(hello)))]);
  const reply = await Promise.race([
    readMsg(bi.recv).then((b) => JSON.parse(b.toString())),
    conn.closed().then(() => "closed"),
  ]).catch(() => "closed");
  return { conn, bi, reply };
}

async function main() {
  const tmp = makeTmp("rh-iroh-");
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp, dataDir: ".pocketdesk-irohtest", env: { RH_IROH: "local" } });
  await d.ready;

  let ticket = null;
  for (let i = 0; i < 50 && !ticket; i++) {
    const html = await fetch(`http://127.0.0.1:${PORT}/pair`).then((r) => r.text());
    ticket = JSON.parse(Buffer.from(html.match(/pocketdesk:\/\/pair#([\w-]+)/)[1], "base64url").toString()).i;
    if (!ticket) await new Promise((r) => setTimeout(r, 100));
  }
  check("pairing QR carries an iroh ticket", typeof ticket === "string" && ticket.length > 20);

  const phone = await dialAndHello(ticket, { type: "hello", token: TOKEN, name: "phone" });
  check("master token over iroh pairs and returns a device token", phone.reply?.type === "welcome" && typeof phone.reply.deviceToken === "string");
  await phone.bi.send.writeAll([...frame(Buffer.from(JSON.stringify({ type: "device_list" })))]);
  let list;
  do list = JSON.parse((await readMsg(phone.bi.recv)).toString()); while (list.type !== "device_list");
  const me = list.items.find((x) => x.id === phone.reply.clientId);
  check("device is bound to the iroh key it paired from", typeof me?.endpointId === "string" && me.endpointId.length > 20);

  const stolen = await dialAndHello(ticket, { type: "hello", token: phone.reply.deviceToken });
  check("device token from a different iroh key is refused", stolen.reply === "closed");

  const bad = await dialAndHello(ticket, { type: "hello", token: "wrong" });
  check("bad token over iroh is refused", bad.reply === "closed");

  // GOP streams, in process: a keyframe opens a stream led by the cached config.
  const srv = await endpoint([alpn]);
  const cli = await endpoint();
  const accepted = (async () => {
    const inc = await srv.acceptNext();
    const conn = await (await inc.accept()).connect();
    return new IrohSocket(conn, await conn.acceptBi());
  })();
  const conn = await cli.connect(srv.addr(), alpn);
  const bi = await conn.openBi();
  await bi.send.writeAll([...frame(Buffer.from("{}"))]);
  const sock = await accepted;
  const pkt = (n) => Buffer.from([n, n, n]);
  sock.sendVideo(0, pkt(9));
  sock.sendVideo(1, pkt(1));
  sock.sendVideo(2, pkt(2));
  const gopId = async (s) => Buffer.from(await s.readExact(4)).readUInt32BE(0);
  const s1 = await conn.acceptUni();
  const id1 = await gopId(s1);
  const first = [await readMsg(s1), await readMsg(s1), await readMsg(s1)].map((b) => b[0]);
  check("first GOP stream is numbered, then config, key, delta", id1 === 1 && first.join() === "0,1,2");
  sock.sendVideo(1, pkt(3));
  const s2 = await conn.acceptUni();
  const id2 = await gopId(s2);
  const second = [await readMsg(s2), await readMsg(s2)].map((b) => b[0]);
  check("next keyframe opens a new stream that repeats the config", id2 === 2 && second.join() === "0,1");
  sock.onVideoAck(2, 2);
  check("a viewer that has read everything is not late", sock.lagMs() === 0);
  // A viewer that stops reading leaves the GOP unfinished: the next keyframe reports congestion.
  sock.sendVideo(1, Buffer.alloc(4 << 20, 5));
  await new Promise((r) => setTimeout(r, 300));
  check("a GOP still unsent when the next keyframe comes reports congestion", sock.sendVideo(1, pkt(6)) === false);
  // Acks say the viewer has not read the newest GOP for 1.6 s: late even with nothing queued here.
  sock.onVideoAck(4, 0);
  await new Promise((r) => setTimeout(r, 1600));
  check("an ack showing the viewer 1.6 s behind reports congestion", sock.lagMs() > 1500 && sock.sendVideo(1, pkt(7)) === false);
  sock.close();

  await teardown(tmp);
  finish();
  process.exit(0); // live endpoints would otherwise keep the process up
}

main().catch((e) => { console.error(e); process.exit(1); });
