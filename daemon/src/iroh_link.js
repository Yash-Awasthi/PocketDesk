/**
 * iroh transport: a phone dials this PC by its public key from any network.
 * iroh hole-punches a direct QUIC path and falls back to an end-to-end
 * encrypted relay, so no VPN, port forward or inbound rule is needed.
 *
 * Each connection is wrapped as a ws-like socket and handed to the same
 * connection handler as /ws, so auth, handlers and broadcast are shared.
 *
 * Wire (ALPN pocketdesk/1): the client opens one bidirectional stream for
 * control; each message both ways is a u32 length then UTF-8 JSON. The daemon
 * sends desktop video as one unidirectional stream per GOP: a u32 GOP number,
 * then each packet as a u32 length and [kind, ...annexB]. A newer GOP stream
 * supersedes older ones. The viewer acks {g, f} (GOP, packets read) over control.
 */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export const ALPN = "pocketdesk/1";
const LAG_LIMIT = 1_500_000; // same backlog limit as the ws video path
const BEHIND_BYTES = 128 << 10;
// Acks trail by up to a quarter second plus one-way delay; past this the picture is stale.
const LATE_MS = 1500;
const MAX_MESSAGE = 8 << 20; // largest control message; checked before auth
const KIND_CONFIG = 0, KIND_KEY = 1;

// The binding drops an endpoint JS no longer references, and every connection with it.
const live = new Set();

/**
 * Binds the endpoint, or resolves null when the optional binding is missing.
 * `relays`: "off" for direct-only, a list of relay URLs for self-hosted relays
 * (no n0 service is contacted), or empty for n0's public relays and discovery.
 */
export async function startIroh({ dir, relays, onConnection }) {
  let iroh;
  try { iroh = await import("@number0/iroh"); } catch { return null; }
  const { Endpoint, RelayMode, SecretKey, EndpointTicket } = iroh;

  const keyFile = path.join(dir, "iroh.key");
  let key;
  try { key = SecretKey.fromBytes([...fs.readFileSync(keyFile)]); } catch {
    key = SecretKey.generate();
    fs.writeFileSync(keyFile, Buffer.from(key.toBytes()), { mode: 0o600 });
  }

  const b = Endpoint.builder();
  if (relays === "off") { b.applyMinimal(); b.relayMode(RelayMode.disabled()); }
  else if (Array.isArray(relays) && relays.length) { b.applyMinimal(); b.relayMode(RelayMode.customFromUrls(relays)); }
  else b.applyN0();
  b.secretKey(key.toBytes());
  b.alpns([[...Buffer.from(ALPN)]]);
  const ep = await b.bind();
  live.add(ep);

  (async () => {
    for (;;) {
      let inc;
      try { inc = await ep.acceptNext(); } catch { return; }
      if (!inc) return;
      (async () => {
        const conn = await (await inc.accept()).connect();
        const bi = await conn.acceptBi();
        onConnection(new IrohSocket(conn, bi), conn.remoteId().toString());
      })().catch(() => {});
    }
  })();

  // Polled rather than watched: the binding's watchAddr panics outside its runtime.
  return {
    id: ep.id().toString(),
    ticket: () => EndpointTicket.fromAddr(ep.addr()).toString(),
    async close() { live.delete(ep); await ep.close().catch(() => {}); },
  };
}

function frame(payload) {
  const b = Buffer.allocUnsafe(4 + payload.length);
  b.writeUInt32BE(payload.length, 0);
  payload.copy(b, 4);
  return b;
}

/** Serialized writes to one send stream; `queued` counts bytes not yet accepted by it. */
function streamWriter(stream) {
  const w = { queued: 0, dead: false, chain: Promise.resolve() };
  w.write = (buf) => {
    w.queued += buf.length;
    w.chain = w.chain.then(async () => {
      if (!w.dead) await stream.writeAll(Array.from(buf)).catch(() => { w.dead = true; });
      w.queued -= buf.length;
    });
  };
  w.reset = () => { if (!w.dead) { w.dead = true; stream.reset(0n).catch(() => {}); } };
  w.finish = () => { w.chain = w.chain.then(() => (w.dead ? null : stream.finish().catch(() => {}))); };
  return w;
}

/** ws-compatible surface over one iroh connection: send, close, readyState, "message"/"close" events. */
export class IrohSocket extends EventEmitter {
  constructor(conn, bi) {
    super();
    this.conn = conn;
    this.readyState = 1;
    this._ctl = streamWriter(bi.send);
    // Replies and terminal output must not queue behind video; GOP streams count up from 1.
    bi.send.setPriority(2 ** 31 - 1).catch(() => {});
    this._gop = null;
    this._config = null;
    this._prio = 0;
    this._gops = []; // { id, times: send time of each packet } for GOPs the viewer may still be reading
    this._ack = null;
    this._opening = Promise.resolve();
    this._readLoop(bi.recv).catch(() => {}).finally(() => this._closed(1006));
    conn.closed().then(() => this._closed(1006), () => this._closed(1006));
  }

  /** The viewer read `f` packets of GOP `g`. */
  onVideoAck(g, f) {
    this._ack = { g, f };
    while (this._gops.length > 1 && this._gops[0].id < g) this._gops.shift();
  }

  /**
   * How long the oldest packet the viewer has not read yet has been in flight,
   * including what QUIC and the relay buffer out of the daemon's sight. 0 without acks.
   */
  lagMs(now = Date.now()) {
    if (!this._ack) return 0;
    const { g, f } = this._ack;
    const i = this._gops.findIndex((x) => x.id === g);
    const next = i < 0 ? this._gops[0] : f < this._gops[i].times.length ? null : this._gops[i + 1];
    const t = i >= 0 && f < this._gops[i].times.length ? this._gops[i].times[f] : next?.times[0];
    return t === undefined ? 0 : now - t;
  }

  /** Control backlog; the video path keeps its own per-GOP accounting. */
  get bufferedAmount() { return this._ctl.queued; }

  async _readLoop(recv) {
    for (;;) {
      const len = Buffer.from(await recv.readExact(4)).readUInt32BE(0);
      if (len > MAX_MESSAGE) { this.close(1009, "message too big"); return; }
      this.emit("message", Buffer.from(await recv.readExact(len)));
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    this._ctl.write(frame(Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
  }

  /**
   * Queues one desktop video packet. Returns false when the viewer fell too far
   * behind and the current GOP was dropped: the link is slower than the stream.
   */
  sendVideo(kind, data) {
    if (this.readyState !== 1) return true;
    const pkt = Buffer.allocUnsafe(1 + data.length);
    pkt[0] = kind;
    data.copy(pkt, 1);
    if (kind === KIND_CONFIG) { this._config = pkt; return true; }
    if (kind === KIND_KEY) {
      const prev = this._gop;
      this._gop = null;
      // An unfinished GOP is useless once a newer keyframe exists, and a link that cannot
      // finish one GOP before the next is slower than the stream.
      // A few trailing frames still queued is normal; a GOP's worth is not. A stale viewer
      // gets the old GOP reset too, which also drops what QUIC still holds for it.
      const late = this.lagMs() > LATE_MS;
      const behind = !!prev && !prev.dead && (prev.queued > BEHIND_BYTES || late);
      if (prev) { if (prev.queued > 0 || late) prev.reset(); else prev.finish(); }
      const head = this._config;
      const gop = { id: this._gops.length ? this._gops.at(-1).id + 1 : 1, times: [] };
      this._gops.push(gop);
      if (this._gops.length > 30) this._gops.shift();
      const now = Date.now();
      if (head) gop.times.push(now);
      gop.times.push(now);
      this._opening = this._opening.then(async () => {
        const st = await this.conn.openUni();
        await st.setPriority(++this._prio).catch(() => {});
        this._gop = streamWriter(st);
        const id = Buffer.alloc(4);
        id.writeUInt32BE(gop.id, 0);
        this._gop.write(id);
        if (head) this._gop.write(frame(head));
        this._gop.write(frame(pkt));
      }).catch(() => {});
      return !behind;
    }
    const gop = this._gop;
    if (gop && !gop.dead && gop.queued > LAG_LIMIT) { gop.reset(); return false; }
    this._gops.at(-1)?.times.push(Date.now());
    // Chained so deltas stay behind a GOP stream that is still opening.
    this._opening = this._opening.then(() => {
      if (this._gop && !this._gop.dead) this._gop.write(frame(pkt));
    });
    return true;
  }

  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    try { this.conn.close(BigInt(code), [...Buffer.from(String(reason))]); } catch {}
    this._closed(code);
  }

  _closed(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._gop?.reset();
    this.emit("close", code);
  }
}
