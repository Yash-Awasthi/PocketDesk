// SPDX-License-Identifier: GPL-3.0-or-later
// Shared mouse and keyboard between computers. Push the pointer past one edge of this PC's screen and
// it carries on onto a saved PC (Computers page), keyboard and clipboard with it; push it back over
// that PC's matching edge, or press Scroll Lock, and it is home. This PC's side needs Windows
// (scripts/PocketDeskKvm.cs); the other PC only receives, so it may be Windows, a Mac or Linux.
// Idea and flow from TwinDesk's shared cursor (GPL-3.0). Saved in ~/.pocketdesk/kvm.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configDir } from "../config.js";
import { computers } from "./computers.js";

const FILE = path.join(configDir, "kvm.json");
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "PocketDeskKvm.cs");
const SIDES = ["left", "right", "top", "bottom"];
const OPPOSITE = { left: "right", right: "left", top: "bottom", bottom: "top" };
const CSC = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

const load = () => { try { return { on: false, target: null, side: "right", ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return { on: false, target: null, side: "right" }; } };
const save = (s) => { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); };

/** The helper, built once per source version with the compiler Windows ships. */
async function helperExe() {
  const src = fs.readFileSync(SRC);
  const dir = path.join(configDir, "helpers");
  const exe = path.join(dir, `pocketdesk-kvm-${crypto.createHash("sha256").update(src).digest("hex").slice(0, 10)}.exe`);
  if (fs.existsSync(exe)) return exe;
  if (!fs.existsSync(CSC)) throw new Error("the .NET Framework C# compiler is missing from this Windows");
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((res, rej) => execFile(CSC, ["-nologo", "-optimize+", "-target:winexe", `-out:${exe}`, "-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", SRC],
    { windowsHide: true }, (e, out) => (e ? rej(new Error(`could not build the input helper: ${String(out).trim().split("\n").pop()}`)) : res())));
  return exe;
}

export default function kvmHandlers(ctx) {
  const { send, broadcast, desktop, access } = ctx;
  let cfg = load();
  const st = { helper: null, link: null, away: false, error: "", moves: null, ping: null };
  const state = () => ({ type: "kvm", ...cfg, supported: process.platform === "win32", away: st.away, linked: st.link?.ws.readyState === 1, error: st.error });
  const tell = () => broadcast(state());
  const toHelper = (line) => { try { st.helper?.stdin.write(`${line}\n`); } catch {} };
  const toPc = (m) => { if (st.link?.ws.readyState === 1) st.link.ws.send(JSON.stringify({ type: "kvm_in", ...m })); };

  // Stands in for a page socket: the link's replies from the other PC come here.
  const owner = {
    readyState: 1, bufferedAmount: 0, once() {},
    send(data) {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === "pc_closed" && m.id === cfg.target) { st.link = null; if (st.away) goHome(0.5); tell(); return; }
      if (m.type !== "pc_msg" || m.id !== cfg.target) return;
      if (m.msg.type === "kvm_back") {
        goHome(Number(m.msg.along) || 0.5);
        if (typeof m.msg.clip === "string" && m.msg.clip) desktop.clipboardSet({ text: m.msg.clip }).catch?.(() => {});
      } else if (m.msg.type === "kvm_refused") {
        goHome(0.5);
        st.error = m.msg.error || "the other PC refused";
        tell();
      }
    },
  };

  function goHome(along) {
    st.away = false;
    clearInterval(st.ping);
    toHelper(`home ${along}`);
    tell();
  }

  async function onEvent(e) {
    if (e.ev === "cross") {
      if (st.link?.ws.readyState !== 1) return toHelper("home 0.5");
      st.away = true;
      st.error = "";
      // This PC's clipboard goes along, so a paste over there is what was copied here.
      const clip = await desktop.clipboardRead?.().catch(() => null);
      toPc({ t: "enter", side: OPPOSITE[cfg.side], along: e.along, clip: clip?.text || undefined, from: process.platform });
      clearInterval(st.ping);
      st.ping = setInterval(() => toHelper("ping"), 1000);
      tell();
    } else if (e.ev === "m") {
      // Moves are summed and sent every 8 ms: the link carries the latest position, not a backlog.
      if (st.moves) { st.moves.dx += e.dx; st.moves.dy += e.dy; return; }
      st.moves = { dx: e.dx, dy: e.dy };
      setTimeout(() => { const m = st.moves; st.moves = null; if (st.away) toPc({ t: "move", ...m }); }, 8);
    } else if (e.ev === "b") toPc({ t: "button", button: e.b, down: !!e.d });
    else if (e.ev === "w") toPc({ t: "wheel", wheel: e.v, hwheel: e.h });
    else if (e.ev === "k") toPc({ t: "key", vk: e.vk, down: !!e.d });
    else if (e.ev === "home") { toPc({ t: "leave" }); st.away = false; clearInterval(st.ping); tell(); }
  }

  async function apply() {
    const want = cfg.on && cfg.target && process.platform === "win32";
    if (!want) {
      if (st.away) toPc({ t: "leave" });
      st.away = false;
      clearInterval(st.ping);
      try { st.helper?.stdin.end(); } catch {}
      st.helper = null;
      st.link?.ws.close();
      st.link = null;
      return tell();
    }
    try {
      if (st.link?.id !== cfg.target || st.link.ws.readyState !== 1) {
        st.link?.ws.close();
        st.link = await computers.link(owner, cfg.target);
      }
      if (!st.helper) {
        const p = spawn(await helperExe(), [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        st.helper = p;
        let buf = "";
        p.stdout.on("data", (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            try { if (line) onEvent(JSON.parse(line)); } catch {}
          }
        });
        p.stderr.on("data", (d) => { st.error = String(d).trim(); });
        p.on("exit", () => { if (st.helper === p) { st.helper = null; st.away = false; clearInterval(st.ping); tell(); } });
        p.on("error", (e) => { st.error = e.message; });
      }
      toHelper(`side ${cfg.side}`);
      st.error = "";
    } catch (e) { st.error = e.message; }
    tell();
  }
  // Comes back by itself after a restart; a PC that is off is tried again now and then.
  setTimeout(apply, 3000).unref?.();
  setInterval(() => { if (cfg.on && st.link?.ws.readyState !== 1) apply(); }, 30_000).unref?.();

  // ── the receiving side ──
  const recv = { pos: null, box: null, side: null, owner: null, busy: false, next: null, held: new Set() };
  const bounds = async () => {
    if (!desktop.monitorList) await desktop.monitors();
    const l = desktop.monitorList || [];
    if (!l.length) return null;
    const x = Math.min(...l.map((m) => m.x)), y = Math.min(...l.map((m) => m.y));
    return { x, y, w: Math.max(...l.map((m) => m.x + m.w)) - x, h: Math.max(...l.map((m) => m.y + m.h)) - y };
  };
  // One injection at a time; while one runs, only the newest position waits.
  async function moveTo(p) {
    if (recv.busy) { recv.next = p; return; }
    recv.busy = true;
    try { await desktop.inputMouse({ x: Math.round(p.x), y: Math.round(p.y) }); } catch {}
    recv.busy = false;
    if (recv.next) { const n = recv.next; recv.next = null; moveTo(n); }
  }
  function release() {
    for (const h of recv.held) {
      if (h.startsWith("k:")) desktop.inputKey({ key: Number(h.slice(2)), press: "up" }).catch?.(() => {});
      else desktop.inputMouse({ press: "up", button: h.slice(2) }).catch?.(() => {});
    }
    recv.held.clear();
    recv.pos = null;
  }

  return {
    async kvm_get(ws) { send(ws, state()); },
    async kvm_set(ws, msg) {
      if (typeof msg.on === "boolean") cfg.on = msg.on;
      if (SIDES.includes(msg.side)) cfg.side = msg.side;
      if (typeof msg.target === "string" || msg.target === null) cfg.target = msg.target;
      save(cfg);
      await apply();
    },
    /** The pointer and keys of a PC whose pointer crossed over to this one. */
    async kvm_in(ws, msg) {
      if (!access.controlAllowed || ws._viewOnlyForced) {
        if (msg.t === "enter") send(ws, { type: "kvm_refused", error: "control is paused on that PC" });
        return;
      }
      if (msg.t === "enter") {
        release();
        const b = await bounds();
        if (!b) return send(ws, { type: "kvm_refused", error: "that PC cannot take input" });
        const a = Math.max(0, Math.min(1, Number(msg.along) || 0));
        const side = SIDES.includes(msg.side) ? msg.side : "left";
        const edge = { left: { x: b.x + 2, y: b.y + a * (b.h - 1) }, right: { x: b.x + b.w - 3, y: b.y + a * (b.h - 1) },
          top: { x: b.x + a * (b.w - 1), y: b.y + 2 }, bottom: { x: b.x + a * (b.w - 1), y: b.y + b.h - 3 } }[side];
        // A PC keyboard on a Mac: its Ctrl does what Cmd does there, so the two trade places.
        const swap = process.platform === "darwin" && msg.from !== "darwin";
        Object.assign(recv, { box: b, side, owner: ws, pos: edge, armed: false, swap });
        if (typeof msg.clip === "string" && msg.clip) desktop.clipboardSet({ text: msg.clip }).catch?.(() => {});
        if (!ws._kvmHooked) { ws._kvmHooked = true; ws.once?.("close", () => { if (recv.owner === ws) release(); }); }
        return moveTo(recv.pos);
      }
      if (recv.owner !== ws || !recv.pos) return;
      const { box: b, side } = recv;
      if (msg.t === "move") {
        const x = recv.pos.x + (Number(msg.dx) || 0), y = recv.pos.y + (Number(msg.dy) || 0);
        // Out past the edge it came in through: home again, with this PC's clipboard.
        // The way back opens once the pointer was well inside, so a wobble on arrival stays here.
        const depth = side === "left" ? x - b.x : side === "right" ? b.x + b.w - 1 - x : side === "top" ? y - b.y : b.y + b.h - 1 - y;
        if (depth > 40) recv.armed = true;
        const out = recv.armed && (side === "left" ? x < b.x : side === "right" ? x > b.x + b.w - 1 : side === "top" ? y < b.y : y > b.y + b.h - 1);
        if (out && !recv.held.size) {
          const along = side === "left" || side === "right" ? (y - b.y) / Math.max(1, b.h - 1) : (x - b.x) / Math.max(1, b.w - 1);
          release();
          const clip = await desktop.clipboardRead?.().catch(() => null);
          return send(ws, { type: "kvm_back", along: Math.max(0, Math.min(1, along)), clip: clip?.text || undefined });
        }
        recv.pos = { x: Math.max(b.x, Math.min(b.x + b.w - 1, x)), y: Math.max(b.y, Math.min(b.y + b.h - 1, y)) };
        return moveTo(recv.pos);
      }
      if (msg.t === "button" && ["left", "right", "middle"].includes(msg.button)) {
        if (msg.down) recv.held.add(`b:${msg.button}`); else recv.held.delete(`b:${msg.button}`);
        return desktop.inputMouse({ x: Math.round(recv.pos.x), y: Math.round(recv.pos.y), press: msg.down ? "down" : "up", button: msg.button });
      }
      if (msg.t === "wheel") return desktop.inputMouse({ wheel: Number(msg.wheel) || undefined, hwheel: Number(msg.hwheel) || undefined });
      if (msg.t === "key") {
        const SWAP = { 0x11: 0x5b, 0xa2: 0x5b, 0xa3: 0x5c, 0x5b: 0xa2, 0x5c: 0xa3 };
        const vk = recv.swap && SWAP[Number(msg.vk)] ? SWAP[Number(msg.vk)] : Number(msg.vk);
        if (msg.down) recv.held.add(`k:${vk}`); else recv.held.delete(`k:${vk}`);
        return desktop.inputKey({ key: vk, press: msg.down ? "down" : "up" });
      }
      if (msg.t === "leave") release();
    },
  };
}
