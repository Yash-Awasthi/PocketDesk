// Remote desktop bridge absorption test — exercises the rd_* protocol surface
// (rustdesk/remodex inspiration): session lifecycle with async connect,
// frame buffering, input forwarding gated on connected state, quality
// presets, stats. Fully in-memory — deterministic, no external processes.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-t-");

const PORT = 8814;
const CLI_PORT = 46814;
const TOKEN = "rdtoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Create session (connect is async — 500ms).
  c.send({ type: "rd_create", hostName: "workstation", hostIp: "192.168.1.10", quality: "high" });
  const s = await c.next((m) => m.type === "rd_session");
  check("rd_create returns session", !!s.session.id && s.session.quality === "high");
  const sid = s.session.id;

  // Async connect completes and broadcasts.
  const connected = await c.next((m) => m.type === "rd_event" && m.rdEvent === "connected" && m.id === sid, 10000);
  check("session connects asynchronously", !!connected);

  // Input forwarding works once connected.
  c.send({ type: "rd_input", sessionId: sid, inputType: "mouse_click", x: 100, y: 200, button: 0 });
  const inp = await c.next((m) => m.type === "rd_input_ok");
  check("input forwarded when connected", inp.ok === true);
  const inpEvt = await c.next((m) => m.type === "rd_event" && m.rdEvent === "forwarded");
  check("input event broadcast", inpEvt.event && inpEvt.event.x === 100);

  // Frames buffer (no crash) + broadcast.
  c.send({ type: "rd_frame", sessionId: sid, frameNumber: 1, width: 1920, height: 1080, data: "ZmFrZQ==" });
  await c.next((m) => m.type === "rd_frame_ok");
  const frameEvt = await c.next((m) => m.type === "rd_event" && m.rdEvent === "received");
  check("frame processed + broadcast", frameEvt.frameNumber === 1);

  // Quality presets adjust fps/resolution.
  c.send({ type: "rd_quality", sessionId: sid, quality: "ultra" });
  await c.next((m) => m.type === "rd_quality_ok");
  c.send({ type: "rd_list" });
  const lst = await c.next((m) => m.type === "rd_list");
  const ultra = lst.items.find((x) => x.id === sid);
  check("quality preset applies (ultra → 120fps)", ultra.fps === 120 && ultra.resolution.width === 2560);

  // Unknown session input rejected.
  c.send({ type: "rd_input", sessionId: "nope", inputType: "key_press", key: "a" });
  const bad = await c.next((m) => m.type === "rd_input_ok");
  check("input to unknown session rejected", bad.ok === false);

  // Stats + disconnect.
  c.send({ type: "rd_stats" });
  const stats = await c.next((m) => m.type === "rd_stats");
  check("stats count active sessions", stats.activeSessions === 1 && stats.totalSessions === 1);

  c.send({ type: "rd_disconnect", sessionId: sid });
  const disc = await c.next((m) => m.type === "rd_disconnected");
  check("disconnect acks", disc.ok === true);
  c.send({ type: "rd_stats" });
  const stats2 = await c.next((m) => m.type === "rd_stats");
  check("active drops after disconnect", stats2.activeSessions === 0);

  await c.close();
await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
