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
import { resolvePath } from "../fs_ops.js";

const FILE = path.join(configDir, "kvm.json");
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "PocketDeskKvm.cs");
const SIDES = ["left", "right", "top", "bottom"];
const OPPOSITE = { left: "right", right: "left", top: "bottom", bottom: "top" };
const CSC = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

// links: one saved PC past each edge of this one; with several, each PC lists its own neighbours (a mesh).
const load = () => {
  let c;
  try { c = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { c = {}; }
  // Older settings named one target and one side.
  const links = Array.isArray(c.links) ? c.links : c.target ? [{ target: c.target, side: SIDES.includes(c.side) ? c.side : "right" }] : [];
  return { on: !!c.on, links: links.filter((l) => l && typeof l.target === "string" && SIDES.includes(l.side)) };
};
const save = (s) => { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); };
const CHUNK = 192 << 10;

/** The files selected in the File Explorer window in front, for a drag that crossed the edge. */
function explorerSelection() {
  const ps = "$fg=(Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();' -Name W -PassThru)::GetForegroundWindow().ToInt64();" +
    "$s=New-Object -ComObject Shell.Application; foreach($w in $s.Windows()){ if($w.HWND -eq $fg){ $w.Document.SelectedItems() | ForEach-Object { $_.Path }; break } }";
  return new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps], { windowsHide: true, timeout: 8000 },
    (e, out) => resolve(e ? [] : String(out).split(/\r?\n/).map((l) => l.trim()).filter((f) => f && fs.existsSync(f) && fs.statSync(f).isFile()))));
}

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
  // links: target id -> the link to it; active: the PC the pointer is on while away.
  const st = { helper: null, links: new Map(), active: null, away: false, error: "", moves: null, ping: null };
  const linked = (t) => st.links.get(t)?.ws?.readyState === 1;
  const state = () => ({
    type: "kvm", on: cfg.on, links: cfg.links.map((l) => ({ ...l, linked: linked(l.target) })),
    target: cfg.links[0]?.target || null, side: cfg.links[0]?.side || "right",
    supported: process.platform === "win32", away: st.away, active: st.active, linked: cfg.links.some((l) => linked(l.target)), error: st.error,
  });
  const tell = () => broadcast(state());
  const toHelper = (line) => { try { st.helper?.stdin.write(`${line}\n`); } catch {} };
  const toPc = (m, t = st.active) => { const l = st.links.get(t); if (l?.ws.readyState === 1) l.ws.send(JSON.stringify({ type: "kvm_in", ...m })); };
  const waiting = new Map(); // remote path -> resolve, for stop-and-wait file writes to another PC

  // Stands in for a page socket, one per linked PC: its replies come here.
  const ownerFor = (target) => ({
    readyState: 1, bufferedAmount: 0, once() {},
    send(data) {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === "pc_closed" && m.id === target) { st.links.delete(target); if (st.away && st.active === target) goHome(0.5); tell(); return; }
      if (m.type !== "pc_msg" || m.id !== target) return;
      if (m.msg.type === "fwritten") { waiting.get(m.msg.path)?.(m.msg); return; }
      if (m.msg.type === "kvm_back") {
        goHome(Number(m.msg.along) || 0.5);
        if (typeof m.msg.clip === "string" && m.msg.clip) desktop.clipboardSet({ text: m.msg.clip }).catch?.(() => {});
      } else if (m.msg.type === "kvm_refused") {
        goHome(0.5);
        st.error = m.msg.error || "the other PC refused";
        tell();
      }
    },
  });

  function goHome(along) {
    st.away = false;
    clearInterval(st.ping);
    toHelper(`home ${along}`);
    tell();
  }

  /** Files dragged over the edge: written into the other PC's Downloads\PocketDesk, then dropped where the button is let go. */
  async function carry(target, files) {
    const l = st.links.get(target);
    if (!l) return;
    const sent = [];
    for (const f of files.slice(0, 50)) {
      const remote = `~/Downloads/PocketDesk/${path.basename(f)}`;
      try {
        const fd = fs.openSync(f, "r");
        try {
          const buf = Buffer.alloc(CHUNK);
          for (let off = 0; ;) {
            const n = fs.readSync(fd, buf, 0, CHUNK, off);
            const ack = new Promise((r) => { waiting.set(remote, r); setTimeout(() => r({ error: "the other PC did not answer" }), 30_000).unref?.(); });
            l.ws.send(JSON.stringify({ type: "fwrite", path: remote, data: buf.subarray(0, n).toString("base64"), append: off > 0 }));
            const a = await ack;
            waiting.delete(remote);
            if (a.error) throw new Error(a.error);
            off += n;
            if (n < CHUNK) break;
          }
        } finally { fs.closeSync(fd); }
        sent.push(remote);
      } catch (e) { st.error = `${path.basename(f)}: ${e.message}`; tell(); }
    }
    if (sent.length) toPc({ t: "files", files: sent }, target);
  }

  async function onEvent(e) {
    if (e.ev === "cross") {
      const link = cfg.links.find((l) => l.side === e.side) || cfg.links[0];
      if (!link || !linked(link.target)) return toHelper("home 0.5");
      st.active = link.target;
      st.away = true;
      st.error = "";
      // This PC's clipboard goes along, so a paste over there is what was copied here.
      const clip = await desktop.clipboardRead?.().catch(() => null);
      const files = e.drag ? await explorerSelection() : [];
      toPc({ t: "enter", side: OPPOSITE[link.side], along: e.along, clip: clip?.text || undefined, from: process.platform, drag: files.length > 0 });
      clearInterval(st.ping);
      st.ping = setInterval(() => toHelper("ping"), 1000);
      tell();
      if (files.length) carry(link.target, files);
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
    const want = cfg.on && cfg.links.length && process.platform === "win32";
    if (!want) {
      if (st.away) toPc({ t: "leave" });
      st.away = false;
      clearInterval(st.ping);
      try { st.helper?.stdin.end(); } catch {}
      st.helper = null;
      for (const l of st.links.values()) l.ws?.close();
      st.links.clear();
      return tell();
    }
    try {
      const targets = new Set(cfg.links.map((l) => l.target));
      for (const [t, l] of st.links) if (!targets.has(t)) { l.ws?.close(); st.links.delete(t); }
      st.error = "";
      for (const t of targets) {
        if (linked(t)) continue;
        try { st.links.set(t, { ws: (await computers.link(ownerFor(t), t)).ws }); } catch (e) { st.error = e.message; }
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
      toHelper(`side ${cfg.links.map((l) => l.side).join(",")}`);
    } catch (e) { st.error = e.message; }
    tell();
  }
  // Comes back by itself after a restart; a PC that is off is tried again now and then.
  setTimeout(apply, 3000).unref?.();
  setInterval(() => { if (cfg.on && cfg.links.some((l) => !linked(l.target))) apply(); }, 30_000).unref?.();

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
  /** Carried files into whatever is under the pointer: a click to focus it, then a paste of the files. */
  async function dropHere() {
    const files = recv.drop?.files || [];
    recv.drop = null;
    if (!files.length || !recv.pos) return;
    const at = { x: Math.round(recv.pos.x), y: Math.round(recv.pos.y) };
    await desktop.inputMouse({ ...at, click: "left" }).catch?.(() => {});
    const r = await desktop.clipboardSet({ files }).catch(() => null);
    if (r?.ok) await desktop.inputKey({ key: 86, modifiers: [process.platform === "darwin" ? "win" : "ctrl"] }).catch?.(() => {});
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
      if (Array.isArray(msg.links)) {
        // One PC per edge, and each PC once.
        const sides = new Set(), targets = new Set();
        cfg.links = msg.links.filter((l) => l && typeof l.target === "string" && SIDES.includes(l.side) && !sides.has(l.side) && !targets.has(l.target)
          && sides.add(l.side) && targets.add(l.target)).map((l) => ({ target: l.target, side: l.side }));
      } else if (typeof msg.target === "string" || msg.target === null) {
        const side = SIDES.includes(msg.side) ? msg.side : cfg.links[0]?.side || "right";
        cfg.links = msg.target ? [{ target: msg.target, side }] : [];
      } else if (SIDES.includes(msg.side) && cfg.links[0]) cfg.links[0].side = msg.side;
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
        // A file drag that crossed: the files follow, and land where the button is let go here.
        Object.assign(recv, { box: b, side, owner: ws, pos: edge, armed: false, swap, drop: msg.drag ? { files: null, released: false } : null });
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
      if (msg.t === "files" && Array.isArray(msg.files) && recv.drop) {
        recv.drop.files = msg.files.slice(0, 50).map((f) => { try { return resolvePath(String(f)); } catch { return null; } }).filter((f) => f && fs.existsSync(f));
        if (recv.drop.released) return dropHere();
        return;
      }
      if (msg.t === "button" && msg.button === "left" && !msg.down && recv.drop && !recv.held.has("b:left")) {
        recv.drop.released = true;
        if (recv.drop.files) return dropHere();
        return;
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
