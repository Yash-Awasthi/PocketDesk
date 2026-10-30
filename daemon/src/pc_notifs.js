// SPDX-License-Identifier: GPL-3.0-or-later
// This PC's notifications, read from Windows' notification database
// (%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db, readable by the signed-in user)
// and polled once a second while a phone wants them. UserNotificationListener would need package
// identity. Approach from TwinDesk's Notifs.cs (GPL-3.0).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

const DB = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Notifications", "wpndatabase.db");
const QUERY = "SELECT n.Id AS id, h.PrimaryId AS app, n.Payload AS payload, n.ArrivalTime AS at FROM Notification n " +
  "JOIN NotificationHandler h ON h.RecordId = n.HandlerId WHERE n.Id > ? AND n.Type = 'toast' ORDER BY n.Id LIMIT 50";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Toast XML: the first <text> of the first binding is the title, the rest the body. */
export function parseToast(xml) {
  const binding = /<binding\b[^>]*>([\s\S]*?)<\/binding>/i.exec(xml)?.[1];
  if (!binding) return null;
  const texts = [];
  for (const m of binding.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    if (/placement\s*=\s*["']attribution["']/i.test(m[1])) continue;
    const v = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x?[\da-f]+|\w+);/gi, (s, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? s).trim();
    if (v) texts.push(v.slice(0, 500));
  }
  return texts.length ? { title: texts[0], body: texts.slice(1).join("\n").slice(0, 1000) } : null;
}

export class PcNotifications extends EventEmitter {
  constructor() {
    super();
    this.last = -1;
    this.names = new Map();
    this.namesAt = 0;
  }

  get supported() { return process.platform === "win32" && fs.existsSync(DB); }

  async open() {
    const { DatabaseSync } = await import("node:sqlite");
    // A URI with mode=ro: Windows keeps the database open, and only a read-only handle shares it.
    return new DatabaseSync(`file:${DB.replace(/\\/g, "/")}?mode=ro`, { readOnly: true });
  }

  async watch(on) {
    clearInterval(this.timer);
    this.timer = null;
    if (!on || !this.supported) return;
    let db;
    try { db = await this.open(); this.last = Number(db.prepare("SELECT IFNULL(MAX(Id), 0) AS m FROM Notification").get().m); }
    catch { return; } finally { try { db?.close(); } catch {} }
    let busy = false;
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await this.poll(); } catch { /* locked for a moment: the next poll */ } finally { busy = false; }
    }, 1000);
    this.timer.unref?.();
  }

  async poll() {
    const db = await this.open();
    let rows;
    try {
      const q = db.prepare(QUERY);
      // ArrivalTime is a FILETIME, past what a JS number holds.
      q.setReadBigInts(true);
      rows = q.all(this.last);
    } finally { db.close(); }
    for (const r of rows) {
      this.last = Math.max(this.last, Number(r.id));
      const t = parseToast(Buffer.from(r.payload || []).toString("utf8").replace(/\0+$/, ""));
      if (!t || !r.app) continue;
      // FILETIME: 100 ns ticks since 1601.
      const at = r.at ? Number(BigInt(r.at) / 10000n - 11644473600000n) : Date.now();
      this.emit("notification", { id: String(r.id), app: r.app, appName: await this.appName(r.app), ...t, at });
    }
  }

  /** The Start menu's name for an app id, reloaded at most once a minute when one is unknown. */
  async appName(aumid) {
    if (!this.names.has(aumid) && Date.now() - this.namesAt > 60_000) {
      this.namesAt = Date.now();
      const list = await new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ForEach-Object { $_.AppID + \"`t\" + $_.Name }"],
        { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 }, (e, out) => resolve(e ? "" : String(out))));
      for (const l of list.split(/\r?\n/)) { const [id, name] = l.split("\t"); if (id && name) this.names.set(id, name); }
    }
    if (this.names.has(aumid)) return this.names.get(aumid);
    const tail = aumid.split(/[!\\]/).pop().replace(/\.exe$/i, "");
    return tail.split(".").pop() || aumid;
  }
}
