/**
 * Desktop control tests — the real frame source for the rd_/desktop surface.
 * On Windows: capture produces a real JPEG (sanity-checked header), input
 * helpers respond ok, streaming starts and stops. Elsewhere: every command
 * degrades with unsupported_platform and the daemon stays healthy.
 */
import { check, failureCount, makeTmp, openAndHello, startDaemon, teardown, REPO } from "./helpers.mjs";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const keyDown = (vk) => execFileSync("powershell.exe", ["-NoProfile", "-Command",
  `(Add-Type -PassThru -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);')::GetAsyncKeyState(${vk}) -band 0x8000`]).toString().trim() !== "0";
const tmp = makeTmp("rh-desk-");

const PORT = 8821;
const CLI_PORT = 46821;
const TOKEN = "desktoken";

async function main() {
  // A run that died mid-way can leave the approval flag behind in the test home.
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Status reflects platform support either way.
  c.send({ type: "desktop_status" });
  const st = await c.next((m) => m.type === "desktop_status");
  check("desktop_status reports support + counters", typeof st.supported === "boolean" && st.clients === 0 && Array.isArray(st.lastFrame) === false);

  // Console mode adds secure-desktop following to the helper scripts, and only then.
  // IS_CONSOLE is read at module load, so probe it in a subprocess with RH_CONSOLE set.
  const probeFollow = (env) => JSON.parse(execFileSync(process.execPath, ["-e", `
    import("./src/desktop_capture.js").then(m => {
      const c = new m.DesktopController();
      const s = c.helperInput.script + c.helperCapture.script + c.helperClip.script;
      process.stdout.write(JSON.stringify({ follow: /void FollowInput/.test(s), calls: (s.match(/::FollowInput\\(\\)/g) || []).length }));
    });
  `], { cwd: path.join(REPO, "daemon"), env: { ...process.env, RH_HOME: path.join(os.tmpdir(), "rh-home-" + PORT), ...env } }).toString());
  const plainScripts = probeFollow({ RH_CONSOLE: "" });
  check("no desktop-follow without RH_CONSOLE", plainScripts.follow === false && plainScripts.calls === 0);
  if (IS_WIN) {
    const consoleScripts = probeFollow({ RH_CONSOLE: "1" });
    check("desktop-follow present under RH_CONSOLE", consoleScripts.follow === true && consoleScripts.calls === 2);
  }

  if (!IS_WIN) {
    // Graceful degradation everywhere, no crashes.
    c.send({ type: "desktop_frame" });
    const fe = await c.next((m) => m.type === "desktop_frame_error" || m.type === "desktop_frame");
    check("desktop_frame degrades cleanly", fe.type === "desktop_frame_error" && fe.reason === "unsupported_platform");

    c.send({ type: "desktop_start" });
    const ss = await c.next((m) => m.type === "desktop_started");
    check("desktop_start degrades cleanly", ss.ok === false && ss.reason === "unsupported_platform");
  } else {
    // On-demand frame: real JPEG (SOI marker 0xFFD8), sane dimensions.
    c.send({ type: "desktop_frame" });
    const fr = await c.next((m) => m.type === "desktop_frame" || m.type === "desktop_frame_error", 20000);
    const b64 = fr.base64 || "";
    const head = Buffer.from(b64, "base64").subarray(0, 2);
    check("desktop_frame returns a real JPEG", fr.type === "desktop_frame" && head[0] === 0xff && head[1] === 0xd8 && fr.width > 0 && fr.height > 0);
    check("frame has plausible size", b64.length > 10_000);

    c.send({ type: "desktop_monitors" });
    const mons = await c.next((m) => m.type === "desktop_monitors", 20000);
    check("monitors listed with one primary", mons.ok && mons.monitors.length >= 1 && mons.monitors.filter((m) => m.primary).length === 1 && mons.monitors[0].w > 0);

    // Streaming: start → frames arrive as pushes → stop.
    c.send({ type: "desktop_start", quality: 40 });
    const ss = await c.next((m) => m.type === "desktop_started", 20000);
    check("desktop_start ok", ss.ok === true && ss.quality > 0);
    const cur = await c.next((m) => m.type === "desktop_cursor", 20000);
    check("watchers get the pointer position", Number.isFinite(cur.x) && typeof cur.shape === "string");
    const pushed = await c.next((m) => m.type === "desktop_frame", 20000);
    check("desktop_frame pushed while streaming", Buffer.from(pushed.base64, "base64")[0] === 0xff);
    c.send({ type: "desktop_privacy", on: true });
    const pv = await c.next((m) => m.type === "desktop_privacy", 20000);
    check("privacy mode turns on for a controlling viewer", pv.ok && pv.on);
    // A still desktop pushes no new frames, so ask for one.
    c.send({ type: "desktop_frame" });
    const hidden = await c.next((m) => m.type === "desktop_frame", 20000);
    check("the viewer still sees the desktop under privacy mode", Buffer.from(hidden.base64, "base64").length > 10_000);
    c.send({ type: "desktop_privacy", on: false });
    const off = await c.next((m) => m.type === "desktop_privacy" && m.on === false, 20000).catch(() => ({ on: "timeout" }));
    check("privacy mode turns off", off.on === false);
    // Input round-trips while watching (no throw; real effect not asserted — CI safety).
    c.send({ type: "desktop_key", key: 65 });
    const ik = await c.next((m) => m.type === "desktop_input_ok", 15000);
    check("desktop_key ok", ik.ok === true);

    // H.264 needs ffmpeg; the first packet of a stream is always the decoder config.
    if (process.env.FFMPEG_PATH) {
      const v = await openAndHello(PORT, TOKEN);
      const first = new Promise((res) => v.ws.on("message", (raw, bin) => { if (bin) res(raw); }));
      v.send({ type: "desktop_start", video: true, preset: "saver", monitor: 0 });
      const vs = await v.next((m) => m.type === "desktop_started", 30000);
      check("video starts on the chosen monitor", vs.ok && vs.mode === "h264" && vs.monitor === 0);
      check("video stream opens with decoder config", (await first)[0] === 0);
      await v.close();
    } else console.log("SKIP  video (set FFMPEG_PATH)");

    // Clipboard: the user's own text is put back at the end.
    c.send({ type: "clipboard_get" });
    const saved = await c.next((m) => m.type === "clipboard", 20000);
    const tag = "rh-test-" + Date.now();
    c.send({ type: "clipboard_set", text: tag });
    await c.next((m) => m.type === "clipboard_set_ok", 20000);
    c.send({ type: "clipboard_get" });
    const got = await c.next((m) => m.type === "clipboard" && m.text === tag, 20000).catch(() => ({}));
    check("clipboard text round-trips", got.kind === "text");

    const png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    c.send({ type: "clipboard_set", png: png1 });
    await c.next((m) => m.type === "clipboard_set_ok", 20000);
    c.send({ type: "clipboard_get" });
    const img = await c.next((m) => m.type === "clipboard" && m.kind === "image", 20000).catch(() => ({}));
    check("clipboard image round-trips as PNG", img.w === 1 && img.h === 1 && Buffer.from(img.png || "", "base64")[1] === 0x50);

    const upload = "~/Downloads/PocketDesk/rh-test-drop.txt";
    c.send({ type: "fwrite", path: upload, data: Buffer.from("dropped").toString("base64") });
    const wr = await c.next((m) => m.type === "fwritten", 10000);
    c.send({ type: "clipboard_set", files: [upload] });
    await c.next((m) => m.type === "clipboard_set_ok", 20000);
    c.send({ type: "clipboard_get" });
    const fl = await c.next((m) => m.type === "clipboard" && m.kind === "files", 20000).catch(() => ({}));
    check("uploaded file lands on the clipboard as a file", !wr.error && fl.files?.[0]?.name === "rh-test-drop.txt" && fl.files[0].size === 7);

    // A viewer hears what the PC copies, but not its own writes.
    const w = await openAndHello(PORT, TOKEN);
    w.send({ type: "desktop_start", quality: 30 });
    await w.next((m) => m.type === "desktop_started", 20000);
    await new Promise((r) => setTimeout(r, 1200));
    w.send({ type: "clipboard_set", text: tag + "-own" });
    await w.next((m) => m.type === "clipboard_set_ok", 20000);
    // The daemon reads the clipboard right after its own write; Windows lets one process hold it at a time.
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `for ($i = 0; $i -lt 10; $i++) { try { Set-Clipboard -Value '${tag}-pc'; exit 0 } catch { Start-Sleep -Milliseconds 200 } }; exit 1`]);
    const ch = await w.next((m) => m.type === "clipboard_changed", 10000).catch(() => ({}));
    check("PC-side copy is pushed to viewers", ch.text === tag + "-pc");
    const echo = await w.next((m) => m.type === "clipboard_changed" && m.text === tag + "-own", 1000).catch(() => null);
    check("a viewer's own clipboard write is not echoed back", echo === null);
    await w.close();
    c.send({ type: "clipboard_set", text: saved.kind === "text" ? saved.text : "" });
    await c.next((m) => m.type === "clipboard_set_ok", 20000);

    // Stopping the stream drops control: input after a stop is refused, not silently accepted.
    c.send({ type: "desktop_stop" });
    const sp = await c.next((m) => m.type === "desktop_stopped", 10000);
    check("desktop_stop ok", sp.ok === true);
    c.send({ type: "desktop_key", key: 65 });
    const afterStop = await c.next((m) => m.type === "desktop_input_ok", 10000);
    check("input after a stop is refused", afterStop.ok === false && afterStop.error === "view only");

    // View only: the socket sees the screen but cannot touch it.
    const vo = await openAndHello(PORT, TOKEN);
    vo.send({ type: "desktop_start", quality: 30, viewOnly: true });
    const vos = await vo.next((m) => m.type === "desktop_started", 20000);
    vo.send({ type: "desktop_key", key: 0x87 });
    const vok = await vo.next((m) => m.type === "desktop_input_ok", 10000);
    check("view-only viewer cannot send input", vos.viewOnly === true && vok.ok === false && vok.error === "view only");
    await vo.close();

    // Control gate: when the PC owner pauses control, a live viewer is forced to view-only.
    const accessPost = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}?k=${TOKEN}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
    await accessPost("/access/control", { allowed: false });
    const g = await openAndHello(PORT, TOKEN);
    g.send({ type: "desktop_start", quality: 30 });
    const gs = await g.next((m) => m.type === "desktop_started", 20000);
    g.send({ type: "desktop_key", key: 0x87 });
    const gk = await g.next((m) => m.type === "desktop_input_ok", 10000);
    check("control paused forces view-only", gs.viewOnly === true && gk.ok === false && gk.error === "view only");
    await g.close();
    await accessPost("/access/control", { allowed: true });

    // Recording: with the flag on, a watched screen becomes an MP4 and a terminal an asciicast.
    const home = path.join(os.tmpdir(), "rh-home-" + PORT);
    const recDir = path.join(home, "recordings");
    fs.rmSync(recDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(home, "record-sessions"), "");
    const r1 = await openAndHello(PORT, TOKEN);
    r1.send({ type: "create", harness: "node", cwd: os.tmpdir() });
    const term = await r1.next((m) => m.type === "created", 15000);
    r1.send({ type: "in", id: term.id, data: Buffer.from('console.log("rec-" + 42)\r').toString("base64") });
    await r1.next((m) => m.type === "out" && Buffer.from(m.data, "base64").toString().includes("rec-42"), 15000).catch(() => null);
    r1.send({ type: "kill", id: term.id });
    await r1.next((m) => m.type === "exit", 10000);
    r1.send({ type: "desktop_start", quality: 30 });
    const rs = await r1.next((m) => m.type === "desktop_started", 20000);
    if (process.env.FFMPEG_PATH) await new Promise((r) => setTimeout(r, 4000));
    r1.send({ type: "desktop_stop" });
    await r1.next((m) => m.type === "desktop_stopped", 10000);
    await new Promise((r) => setTimeout(r, 2500));
    const files = fs.existsSync(recDir) ? fs.readdirSync(recDir) : [];
    const cast = files.find((f) => f.endsWith(".cast"));
    const castText = cast ? fs.readFileSync(path.join(recDir, cast), "utf8") : "";
    check("terminal session recorded as asciicast", JSON.parse(castText.split("\n")[0] || "{}").version === 2 && castText.includes("rec-42"));
    const log = fs.existsSync(path.join(recDir, "sessions.log")) ? fs.readFileSync(path.join(recDir, "sessions.log"), "utf8") : "";
    check("viewer joining and leaving is logged", log.includes('"viewer_joined"') && log.includes('"viewer_left"'));
    if (process.env.FFMPEG_PATH) {
      const mp4 = files.find((f) => f.endsWith(".mp4"));
      const size = mp4 ? fs.statSync(path.join(recDir, mp4)).size : 0;
      check("watched screen recorded as MP4", rs.recording === true && size > 10_000);
    }
    fs.rmSync(path.join(home, "record-sessions"), { force: true });
    await r1.close();

    // Held key: F24 goes down, and dropping the socket releases it. A watcher may control.
    const h = await openAndHello(PORT, TOKEN);
    h.send({ type: "desktop_start", quality: 30 });
    await h.next((m) => m.type === "desktop_started", 20000);
    h.send({ type: "desktop_key", key: 0x87, press: "down" });
    await h.next((m) => m.type === "desktop_input_ok", 15000);
    check("held key is down", keyDown(0x87));
    await h.close();
    await new Promise((r) => setTimeout(r, 1500));
    check("dropped viewer releases held key", !keyDown(0x87));
  }

  await finish(d, c);
}

async function finish(d, c) {
  await c.close();
  await teardown(); // kills every spawned daemon (children registry)
  if (failureCount() > 0) {
    console.error("FAILED: " + failureCount());
    process.exit(1);
  }
  console.log("ALL PASS");
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await teardown();
  process.exit(1);
});
