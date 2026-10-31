// SPDX-License-Identifier: GPL-3.0-or-later
// The phone's shared storage as a WebDAV share on this PC, so File Explorer maps it as a drive.
// Bound to loopback, under a random path that only this PC's page learns; every request becomes
// a phone_fs (phone app) or adb_fs (phone control) call, the same ones the Phone files page uses.
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const CHUNK = 256 << 10;
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

export class PhoneDav {
  /** fsCall({ op, path, ... }) resolves to the phone's reply object. */
  constructor(fsCall, port) {
    this.fsCall = fsCall;
    this.port = port;
    this.secret = crypto.randomBytes(12).toString("hex");
    this.server = null;
  }

  get url() { return `http://127.0.0.1:${this.port}/${this.secret}/`; }
  /** The UNC form Explorer and `net use` take: \\127.0.0.1@port\secret. */
  get unc() { return `\\\\127.0.0.1@${this.port}\\${this.secret}`; }

  start() {
    if (this.server) return Promise.resolve();
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message || e)); }));
    return new Promise((resolve, reject) => {
      this.server.once("error", (e) => { this.server = null; reject(e); });
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
  }

  stop() { this.server?.close(); this.server = null; }

  async call(msg) {
    const r = await this.fsCall(msg);
    if (r?.error) throw Object.assign(new Error(r.error), { status: /not a folder|No such|ENOENT|not found|outside/i.test(r.error) ? 404 : 502 });
    return r;
  }

  /** One entry's details, from a listing of its parent; the root is always a folder. */
  async stat(p) {
    if (p === "/") return { name: "", dir: true, size: 0, mtime: Date.now() };
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    const name = p.slice(p.lastIndexOf("/") + 1);
    const r = await this.call({ op: "list", path: parent });
    return (r.items || []).find((i) => i.name === name) || null;
  }

  async handle(req, res) {
    const u = new URL(req.url, "http://x");
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.shift() !== this.secret) { res.writeHead(404).end(); return; }
    if (parts.some((s) => s === ".." || s.includes("\\"))) { res.writeHead(400).end(); return; }
    const p = "/" + parts.join("/");
    const base = `/${this.secret}`;
    res.setHeader("DAV", "1,2");
    res.setHeader("MS-Author-Via", "DAV");
    try {
      switch (req.method) {
        case "OPTIONS":
          res.writeHead(200, { Allow: "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK" }).end();
          return;
        case "PROPFIND": {
          await drain(req);
          const self = await this.stat(p);
          if (!self) { res.writeHead(404).end(); return; }
          const rows = [{ href: base + encodePath(p) + (self.dir && p !== "/" ? "/" : p === "/" ? "/" : ""), ...self }];
          if (self.dir && req.headers.depth !== "0") {
            const r = await this.call({ op: "list", path: p });
            for (const i of r.items || []) rows.push({ href: base + encodePath((p === "/" ? "" : p) + "/" + i.name) + (i.dir ? "/" : ""), ...i });
          }
          const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${rows.map(propXml).join("")}</D:multistatus>`;
          res.writeHead(207, { "Content-Type": 'application/xml; charset="utf-8"' }).end(body);
          return;
        }
        case "PROPPATCH": {
          await drain(req);
          res.writeHead(207, { "Content-Type": 'application/xml; charset="utf-8"' })
            .end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${esc(u.pathname)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
          return;
        }
        case "HEAD":
        case "GET": {
          const st = await this.stat(p);
          if (!st || st.dir) { res.writeHead(st ? 405 : 404).end(); return; }
          let start = 0, end = st.size - 1;
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
          if (range) {
            if (range[1]) start = Number(range[1]);
            if (range[2]) end = range[1] ? Math.min(end, Number(range[2])) : st.size - 1;
            if (!range[1] && range[2]) start = Math.max(0, st.size - Number(range[2]));
          }
          const head = { "Content-Type": "application/octet-stream", "Content-Length": Math.max(0, end - start + 1), "Accept-Ranges": "bytes", "Last-Modified": new Date(st.mtime).toUTCString() };
          if (range) head["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
          res.writeHead(range ? 206 : 200, head);
          if (req.method === "HEAD" || st.size === 0) { res.end(); return; }
          let at = start;
          while (at <= end) {
            const r = await this.call({ op: "read", path: p, offset: at });
            const buf = Buffer.from(r.data || "", "base64");
            if (!buf.length) break;
            // A read starts on the asked offset; the last piece may run past the range's end.
            const piece = buf.subarray(0, Math.min(buf.length, end - at + 1));
            if (!res.write(piece)) await new Promise((r2) => res.once("drain", r2));
            at += piece.length;
            if (r.eof) break;
          }
          res.end();
          return;
        }
        case "PUT": {
          // Phone control gathers pieces until last: true, then pushes once; the phone app appends each.
          const key = crypto.createHash("sha1").update(p).digest("hex").slice(0, 12);
          let first = true, pending = Buffer.alloc(0);
          const put = async (piece, last) => {
            await this.call({ op: "write", path: p, data: piece.toString("base64"), append: !first, last, key });
            first = false;
          };
          for await (const d of req) {
            pending = Buffer.concat([pending, d]);
            while (pending.length > CHUNK) { await put(pending.subarray(0, CHUNK), false); pending = pending.subarray(CHUNK); }
          }
          await put(pending, true);
          res.writeHead(201).end();
          return;
        }
        case "DELETE":
          if (p === "/") { res.writeHead(403).end(); return; }
          await this.call({ op: "delete", path: p });
          res.writeHead(204).end();
          return;
        case "MKCOL":
          await drain(req);
          await this.call({ op: "mkdir", path: p });
          res.writeHead(201).end();
          return;
        case "MOVE": {
          const dest = new URL(req.headers.destination || "", "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
          if (dest.shift() !== this.secret || dest.some((s) => s === "..")) { res.writeHead(400).end(); return; }
          await this.call({ op: "rename", path: p, to: "/" + dest.join("/") });
          res.writeHead(201).end();
          return;
        }
        case "LOCK": {
          await drain(req);
          // Explorer locks before it writes; the phone has no locks, so every lock is granted at once.
          const token = `opaquelocktoken:${crypto.randomUUID()}`;
          res.writeHead(200, { "Lock-Token": `<${token}>`, "Content-Type": 'application/xml; charset="utf-8"' })
            .end(`<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`);
          return;
        }
        case "UNLOCK":
          res.writeHead(204).end();
          return;
        default:
          res.writeHead(405).end();
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(e.status || 502).end(e.message);
      else res.destroy();
    }
  }

  /** Maps the share to a free drive letter with `net use`; Windows' WebClient service carries it. */
  async mapDrive() {
    // WebClient is a manual-start service; net use alone does not always wake it.
    await new Promise((r) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Service WebClient -ErrorAction SilentlyContinue"], { windowsHide: true, timeout: 20000 }, () => r()));
    return new Promise((resolve) => {
      execFile("net", ["use", "*", this.unc, "/persistent:no"], { windowsHide: true, timeout: 30000 }, (e, out, err) => {
        const letter = /Drive ([A-Z]:)/i.exec(String(out))?.[1];
        resolve(letter ? { ok: true, drive: letter } : { ok: false, error: String(err || out || e?.message || "net use failed").trim().split(/\r?\n/).pop() });
      });
    });
  }

  unmapDrive(drive) {
    return new Promise((resolve) => execFile("net", ["use", drive, "/delete", "/y"], { windowsHide: true, timeout: 15000 }, () => resolve()));
  }
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
async function drain(req) { for await (const _ of req); }

function propXml(i) {
  const t = new Date(i.mtime || Date.now());
  return `<D:response><D:href>${esc(i.href)}</D:href><D:propstat><D:prop>` +
    `<D:displayname>${esc(i.name)}</D:displayname>` +
    `<D:resourcetype>${i.dir ? "<D:collection/>" : ""}</D:resourcetype>` +
    (i.dir ? "" : `<D:getcontentlength>${Number(i.size) || 0}</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>`) +
    `<D:getlastmodified>${t.toUTCString()}</D:getlastmodified><D:creationdate>${t.toISOString()}</D:creationdate>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}
