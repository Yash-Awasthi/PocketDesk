// SPDX-License-Identifier: GPL-3.0-or-later
// A fake daemon for the hub's Playwright tests: the real static files, the loopback-only
// /access endpoints and one /ws socket, with only the answers replaced. Nothing here runs a
// terminal, a phone or a policy decision; it serves the shapes the pages read.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "public");
const TOKEN = "e2e-token";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const WELCOME = { type: "welcome", os: "win32", deviceToken: TOKEN, protocol: 1 };
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

export async function startFakeDaemon(options = {}) {
  const access = {
    remoteOn: true,
    controlAllowed: true,
    recording: false,
    hasPassword: false,
    totpEnabled: false,
    ...options.access,
  };
  const devices = options.devices ?? [
    {
      id: "d1",
      name: "Pixel 9",
      platform: "Android 16",
      firstSeen: Date.UTC(2026, 9, 1, 8, 0),
      lastSeen: Date.UTC(2026, 10, 26, 9, 30),
      lastIp: "192.168.1.21",
      transport: "iroh",
      online: true,
      revoked: false,
    },
    {
      id: "d2",
      name: "Old phone",
      platform: "Android 13",
      firstSeen: Date.UTC(2026, 9, 2, 9, 0),
      lastSeen: Date.UTC(2026, 10, 20, 8, 0),
      lastIp: "192.168.1.40",
      transport: "lan",
      online: false,
      revoked: true,
    },
  ];
  const history = options.history ?? [
    {
      agent: "claude",
      app: "VS Code",
      id: "s1",
      title: "Fix the build",
      cwd: "C:\\proj\\desk",
      updated: Date.UTC(2026, 10, 26, 9, 0),
      resumable: true,
    },
    {
      agent: "codex",
      app: "CLI",
      id: "s2",
      title: "Add retries",
      cwd: "C:\\proj\\api",
      updated: Date.UTC(2026, 10, 20, 8, 0),
      resumable: true,
    },
    {
      agent: "claude",
      app: "CLI",
      id: "s3",
      title: "Old spike",
      cwd: "C:\\proj\\desk",
      updated: Date.UTC(2026, 9, 15, 7, 0),
      resumable: true,
    },
  ];
  const sessions = options.sessions ?? [
    { id: "0123456789abcdef", harnessId: "claude", kind: "terminal", state: "running" },
  ];
  const calls = [];
  const messages = [];
  let down = false;

  // server.js injects these metas only into loopback responses; this page is always loopback.
  const index = fs
    .readFileSync(path.join(PUBLIC, "index.html"), "utf8")
    .replace(
      '<meta name="theme-color"',
      [
        `<meta name="pd-token" content="${TOKEN}" />`,
        `<meta name="pd-qr" content="pocketdesk://pair#t=${TOKEN}" />`,
        `<meta name="pd-hub" content="https://192.168.1.10:8765/#t=${TOKEN}" />`,
        '<meta name="pd-fp" content="AA:BB:CC:DD" />',
        '<meta name="theme-color"',
      ].join("\n"),
    );

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(index);
    }

    if (p.startsWith("/access")) {
      if (url.searchParams.get("k") !== TOKEN) return json(res, 403, { ok: false, error: "bad token" });
      calls.push({ method: req.method, path: p });

      if (p === "/access" && req.method === "GET") return json(res, 200, access);
      if (p === "/access/devices" && req.method === "GET") return json(res, 200, { items: devices });
      if (p === "/access/audit" && req.method === "GET")
        return json(res, 200, {
          events: devices
            .flatMap((d) => [
              { at: d.firstSeen, kind: "pairing", text: `${d.name} paired (${d.platform})` },
              { at: d.lastSeen, kind: "device", text: `${d.name} connected over ${d.transport}` },
            ])
            .sort((a, b) => b.at - a.at),
          categories: [
            { id: "pairing", label: "Pairing", recorded: true },
            { id: "device", label: "Devices", recorded: true },
            {
              id: "policy",
              label: "Policy changes",
              recorded: false,
              reason: "the daemon stores the current switches only",
            },
            {
              id: "totp",
              label: "Two-factor changes",
              recorded: false,
              reason: "totp.json stores the current secret only",
            },
          ],
        });

      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const payload = body ? JSON.parse(body) : {};
        if (p === "/access/totp/setup") {
          return json(res, 200, {
            ok: true,
            secret: TOTP_SECRET,
            uri: `otpauth://totp/PocketDesk?secret=${TOTP_SECRET}&issuer=PocketDesk`,
          });
        }
        if (p === "/access/totp/enable" || p === "/access/totp/disable") {
          access.totpEnabled = p.endsWith("enable") && payload.code === "123456";
          return json(res, 200, {
            ok: access.totpEnabled === p.endsWith("enable"),
            totpEnabled: access.totpEnabled,
          });
        }
        if (p === "/access/devices/note") {
          const d = devices.find((x) => x.id === payload.clientId);
          if (!d) return json(res, 404, { ok: false, error: "unknown device" });
          d.note = String(payload.note || "").trim();
          return json(res, 200, { ok: true, device: d });
        }
        if (p === "/access/devices/revoke") {
          const d = devices.find((x) => x.id === payload.clientId);
          if (d) {
            d.revoked = true;
            d.online = false;
          }
          return json(res, 200, { ok: true });
        }
        json(res, 404, { ok: false, error: "not found" });
      });
      return undefined;
    }

    const rel = p.replace(/^\/+/, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    if (down) return ws.terminate();
    ws.send(JSON.stringify(WELCOME));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      messages.push(m);
      const reply = (body) => ws.send(JSON.stringify(body));
      if (m.type === "phone_hub") reply({ type: "phone_hub", online: false, name: null, last: {} });
      if (m.type === "adb_state") reply({ type: "adb_state", toolsReady: true, devices: [], serial: null });
      if (m.type === "clippy_status") reply({ type: "clippy_status", running: false, installed: false });
      if (m.type === "clippy_latest") reply({ type: "clippy_latest", ok: false });
      if (m.type === "desktop_monitors")
        reply({
          type: "desktop_monitors",
          monitors: [
            { index: 0, title: "Built-in", w: 1920, h: 1080, primary: true },
            { index: 1, title: "", w: 1280, h: 1024, primary: false },
          ],
          order: [0, 1],
        });
      if (m.type === "pc_list") reply({ type: "pc_list", items: [] });
      if (m.type === "sources_list") reply({ type: "sources_list", items: [] });
      if (m.type === "history_list") reply({ type: "history", items: history });
      if (m.type === "running_state") {
        reply({
          type: "running_state",
          version: { daemon: "0.11.0", protocol: 1, node: "26.8.1" },
          ports: { daemon: 8765, page: 8765, cli: 8766, usb: 8767 },
          sessions: { count: sessions.length, items: sessions },
          streams: { video: 0, desktop: 0, audio: 0, remote: 0 },
          policy: { control: true, remote: true, password: false, totp: false, recording: false },
        });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
    calls,
    messages,
    access,
    devices,
    setDown(v) {
      down = v;
      if (down) for (const client of wss.clients) client.terminate();
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
