// SPDX-License-Identifier: GPL-3.0-or-later
// Other PCs running PocketDesk (Windows, macOS or Linux), viewed and driven from here.
// A page cannot open a socket to another PC's self-signed certificate, so this daemon does:
// it links to the other daemon, checks its certificate against the fingerprint pinned when it was
// added, and relays messages both ways. Saved in ~/.pocketdesk/computers.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import { configDir } from "../config.js";

const FILE = path.join(configDir, "computers.json");
export const BIN_PC = 0x50;

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } };
const save = (list) => { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 }); };
const norm = (fp) => String(fp || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
// What a raw link (a desktop viewer driving the other PC as if it were this one) passes back.
const RAW_BACK = /^(desktop_|control_allowed$|clipboard|video_|sources_list$)/;

/** A pairing link (pocketdesk://pair#…) or its parts: { url, token, fp, name }. */
export function parsePairing(text) {
  const m = /pocketdesk:\/\/pair#([A-Za-z0-9_-]+)/.exec(String(text || ""));
  if (!m) return null;
  try {
    const o = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    return o.u && o.t ? { url: o.u, token: o.t, fp: o.f || "", name: o.n || "", iroh: o.i || "" } : null;
  } catch { return null; }
}

export const computers = { list: () => load(), online: new Map(), link: null, linkOf: null };

export default function computersHandlers(ctx) {
  const { send } = ctx;
  let nextSlot = 1;
  const pub = (c) => ({ id: c.id, name: c.name, url: c.url, os: c.os || null, online: computers.online.has(c.id), anywhere: !!c.iroh });
  const linksOf = (ws) => (ws._pcLinks ||= new Map());

  /**
   * Opens [owner]'s link to saved PC [c]; resolves once the other daemon says welcome. A raw link
   * hands desktop messages and the bare video stream to [owner] as if this PC sent them.
   */
  function link(c, owner, { raw = false } = {}, via = "lan") {
    return new Promise((resolve, reject) => {
      // On the same network straight to it; from anywhere else through iroh, which checks the PC's key itself.
      const ws = via === "iroh" ? ctx.iroh().dial(c.iroh)
        : new WebSocket(c.url, { rejectUnauthorized: false, handshakeTimeout: 4000, maxPayload: 64 << 20 });
      const l = { ws, id: c.id, slot: raw ? 0 : (nextSlot = (nextSlot % 250) + 1), raw, os: c.os, via };
      let welcomed = false;
      ws.on("upgrade", (res) => {
        // A wss link counts only with the certificate the PC showed when it was added.
        const fp = res.socket.getPeerCertificate?.()?.fingerprint256;
        if (c.url.startsWith("wss:") && (!fp || (c.fp && norm(fp) !== norm(c.fp)))) {
          ws.terminate();
          reject(new Error("that PC's certificate changed: remove it and add it again from its pairing link"));
        } else if (fp && !c.fp) c.fp = fp;
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: c.token, password: c.password || undefined, name: `${os.hostname()} (PC)`, platform: "pc", clientId: c.clientId })));
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          if (owner.readyState !== 1 || owner.bufferedAmount > 4_000_000) return;
          owner.send(raw ? data : Buffer.concat([Buffer.from([BIN_PC, l.slot]), data]));
          return;
        }
        let m;
        try { m = JSON.parse(data); } catch { return; }
        if (m.type === "welcome" && !welcomed) {
          welcomed = true;
          // A pairing token becomes this PC's own device token on the other one.
          const list = load();
          const saved = list.find((x) => x.id === c.id);
          if (saved) {
            if (m.deviceToken) saved.token = m.deviceToken;
            Object.assign(saved, { clientId: m.clientId, os: m.os, fp: c.fp, iroh: m.iroh || saved.iroh });
            save(list);
          }
          c.token = saved?.token || c.token;
          c.clientId = m.clientId;
          l.os = c.os = m.os;
          const old = linksOf(owner).get(c.id + (raw ? ":raw" : ""));
          if (old) { old.quiet = true; old.ws.close(); }
          linksOf(owner).set(c.id + (raw ? ":raw" : ""), l);
          computers.online.set(c.id, (computers.online.get(c.id) || 0) + 1);
          resolve(l);
          return;
        }
        // The screen's OS travels with it, so each viewer shows that OS's keys.
        if (raw && m.type === "desktop_started" && !m.os) m.os = l.os;
        if (raw && m.type === "sources_list" && !m.of) {
          // Its sources, named as seen from here.
          const items = (m.items || []).map((x) => ({ ...x, id: x.id === "local" ? `pc:${c.id}` : `pc:${c.id}/${x.id}` }));
          send(owner, { type: "sources_list", of: `pc:${c.id}`, items });
        } else if (raw) { if (RAW_BACK.test(String(m.type))) send(owner, { ...m, source: m.source ? `pc:${c.id}/${m.source}` : `pc:${c.id}` }); }
        else send(owner, { type: "pc_msg", id: c.id, msg: m });
      });
      ws.on("close", (code, reason) => {
        const key = c.id + (raw ? ":raw" : "");
        if (linksOf(owner).get(key) === l) linksOf(owner).delete(key);
        if (!welcomed) {
          reject(new Error(code === 4003 ? "that PC refused the token: add it again from its pairing link"
            : code === 4012 ? "that PC wants its connection password" : code === 4011 ? "that PC wants its two-factor code"
              : `could not reach that PC (${code}${reason?.length ? `: ${reason}` : ""})`));
          return;
        }
        const n = (computers.online.get(c.id) || 1) - 1;
        if (n > 0) computers.online.set(c.id, n); else computers.online.delete(c.id);
        if (!raw) send(owner, { type: "pc_closed", id: c.id, code });
        else if (!l.quiet) send(owner, { type: "desktop_stopped", source: `pc:${c.id}`, why: "the other PC closed the link" });
      });
      ws.on("error", (e) => { if (!welcomed) reject(new Error(`could not reach that PC: ${e.code || e.message}`)); });
      if (!owner._pcHooked) {
        owner._pcHooked = true;
        owner.once?.("close", () => { for (const x of linksOf(owner).values()) x.ws.close(); });
      }
    });
  }

  /** Same network first; a PC that does not answer there is tried through iroh. */
  async function linkAny(c, owner, opts) {
    try { return await link(c, owner, opts, "lan"); } catch (e) {
      if (!c.iroh || !ctx.iroh?.() || /token|password|two-factor|certificate/.test(e.message)) throw e;
      return link(c, owner, opts, "iroh");
    }
  }
  computers.link = async (owner, id, opts) => {
    const c = load().find((x) => x.id === id);
    if (!c) throw new Error("no such PC");
    return linkAny(c, owner, opts);
  };
  computers.linkOf = (owner, id, raw = false) => linksOf(owner).get(id + (raw ? ":raw" : "")) || null;

  return {
    async pc_list(ws) {
      send(ws, { type: "pc_list", items: load().map(pub) });
    },
    /** Adds a PC from its pairing link, or its address and token; the first link pins its certificate. */
    async pc_add(ws, msg) {
      try {
        const p = parsePairing(msg.link) || { url: String(msg.url || "").trim(), token: String(msg.token || "").trim(), fp: msg.fp || "", name: "" };
        if (!/^wss?:\/\/[^/]+/.test(p.url) || !p.token) throw new Error("paste the other PC's pairing link, or its wss:// address and token");
        const c = {
          id: crypto.randomUUID(), name: String(msg.name || p.name || new URL(p.url).hostname).slice(0, 60),
          url: p.url, token: p.token, fp: p.fp, iroh: p.iroh || undefined, password: msg.password ? String(msg.password) : undefined,
        };
        save([...load(), c]);
        try { await linkAny(c, ws); } catch (e) { save(load().filter((x) => x.id !== c.id)); throw e; }
        send(ws, { type: "pc_list", items: load().map(pub) });
      } catch (e) { send(ws, { type: "pc_error", message: e.message }); }
    },
    async pc_rename(ws, msg) {
      const list = load();
      const c = list.find((x) => x.id === msg.id);
      if (c && msg.name) { c.name = String(msg.name).slice(0, 60); save(list); }
      send(ws, { type: "pc_list", items: list.map(pub) });
    },
    async pc_remove(ws, msg) {
      for (const k of [msg.id, msg.id + ":raw"]) { const l = linksOf(ws).get(k); if (l) { l.quiet = true; l.ws.close(); } }
      save(load().filter((x) => x.id !== msg.id));
      send(ws, { type: "pc_list", items: load().map(pub) });
    },
    async pc_connect(ws, msg) {
      try {
        const live = linksOf(ws).get(msg.id);
        const l = live?.ws.readyState === 1 ? live : await computers.link(ws, msg.id);
        const c = load().find((x) => x.id === msg.id);
        send(ws, { type: "pc_linked", id: msg.id, slot: l.slot, os: l.os, name: c?.name });
      } catch (e) { send(ws, { type: "pc_error", id: msg.id, message: e.message }); }
    },
    async pc_disconnect(ws, msg) {
      linksOf(ws).get(msg.id)?.ws.close();
    },
    /** A message for the other PC's daemon, as its own page or phone would send it. */
    async pc_send(ws, msg) {
      const l = linksOf(ws).get(msg.id);
      if (!l || l.ws.readyState !== 1 || !msg.msg || typeof msg.msg !== "object" || msg.msg.type === "hello") return;
      l.ws.send(JSON.stringify(msg.msg));
    },
  };
}
