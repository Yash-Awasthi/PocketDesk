/**
 * Wake-on-LAN — power on a shutdown/sleeping PC from the phone.
 *
 * Absorbed from rustdesk (wake the remote host you manage): send a magic
 * packet (6× 0xFF + 16× the target's MAC) as a UDP broadcast to wake a machine
 * on the LAN. Multiple MACs allowed (wired + wireless NICs).
 */

import dgram from "node:dgram";

const DEFAULT_PORT = 9;
const BROADCASTS = ["255.255.255.255"];

function macBytes(mac) {
  const hex = mac.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 12) return null;
  const bytes = [];
  for (let i = 0; i < 12; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes.every((b) => Number.isFinite(b)) ? Buffer.from(bytes) : null;
}

function magicPacket(macBuf, count = 6) {
  const pre = Buffer.alloc(count, 0xff);
  const body = Buffer.concat(Array.from({ length: 16 }, () => macBuf));
  return Buffer.concat([pre, body]);
}

/**
 * Send a WoL magic packet. macs: string or array of "AA:BB:CC:DD:EE:FF".
 * Returns { ok, sent: [{ mac, port, address }], errors: [] }.
 */
export function wake(macs, { port = DEFAULT_PORT, address } = {}) {
  const list = (Array.isArray(macs) ? macs : String(macs || "").split(/[,;\s]+/)).filter(Boolean);
  if (!list.length) return { ok: false, sent: [], errors: ["no mac address given"] };

  const sent = [];
  const errors = [];
  const targets = address ? [address] : BROADCASTS;
  let pending = 0;
  let settled = false;

  return new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ ok: sent.length > 0, sent, errors });
    };
    for (const mac of list.slice(0, 8)) {
      const macBuf = macBytes(mac);
      if (!macBuf) {
        errors.push(`bad mac: ${mac}`);
        continue;
      }
      const pkt = magicPacket(macBuf);
      for (const target of targets) {
        pending++;
        const sock = dgram.createSocket("udp4");
        const done = () => {
          try { sock.close(); } catch {}
          if (--pending <= 0) finish();
        };
        sock.once("error", (e) => {
          errors.push(`${mac}@${target}: ${e.message}`);
          done();
        });
        sock.bind(() => {
          sock.setBroadcast(true);
          sock.send(pkt, 0, pkt.length, port, target, () => {
            sent.push({ mac, port, address: target });
            done();
          });
        });
      }
    }
    if (pending <= 0) finish();
    else setTimeout(finish, 2000).unref?.(); // never hang the caller
  });
}
