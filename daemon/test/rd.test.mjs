// Remote desktop bridge test — the rd_* protocol surface over the real
// desktop capture/input controller. On Windows a session serves real JPEG
// frames and injects real input; elsewhere the same calls degrade with
// unsupported_platform while session bookkeeping still works.
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const IS_WIN = process.platform === "win32";
const tmp = makeTmp("rh-t-");

const PORT = 8814;
const CLI_PORT = 46814;
const TOKEN = "rdtoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  c.send({ type: "rd_create", hostName: "workstation", hostIp: "192.168.1.10", quality: "high" });
  const s = await c.next((m) => m.type === "rd_session", 20000);
  check("rd_create returns session", !!s.session.id && s.session.quality === "high");
  check("session reports platform support", s.session.supported === IS_WIN);
  const sid = s.session.id;

  const connected = await c.next((m) => m.type === "rd_event" && m.rdEvent === "connected" && m.id === sid, 10000);
  check("session connect broadcasts", !!connected);

  // Frame pull: a real JPEG on Windows (SOI marker 0xFFD8), clean refusal elsewhere.
  c.send({ type: "rd_frame", sessionId: sid });
  const fr = await c.next((m) => m.type === "rd_frame" || m.type === "rd_frame_error", 20000);
  if (IS_WIN) {
    const head = Buffer.from(fr.base64 || "", "base64").subarray(0, 2);
    check("rd_frame returns a real JPEG", fr.type === "rd_frame" && head[0] === 0xff && head[1] === 0xd8);
    check("frame carries real screen size", fr.width > 100 && fr.height > 100);
  } else {
    check("rd_frame degrades cleanly", fr.type === "rd_frame_error" && fr.reason === "unsupported_platform");
    check("no frame dimensions off-platform", fr.width === undefined);
  }

  // Input forwarding reaches the real desktop (a move to a harmless corner).
  c.send({ type: "rd_input", sessionId: sid, inputType: "mouse_move", x: 10, y: 10 });
  const inp = await c.next((m) => m.type === "rd_input_ok", 15000);
  check("input result reflects the platform", inp.ok === IS_WIN);
  const inpEvt = await c.next((m) => m.type === "rd_event" && m.rdEvent === "forwarded");
  check("input event broadcast", inpEvt.event && inpEvt.event.x === 10);

  // Unknown input types are refused before they reach the helper.
  c.send({ type: "rd_input", sessionId: sid, inputType: "teleport", x: 1, y: 1 });
  const badType = await c.next((m) => m.type === "rd_input_ok");
  check("unknown input type rejected", badType.ok === false && badType.reason === "bad_input_type");

  // Quality presets apply.
  c.send({ type: "rd_quality", sessionId: sid, quality: "ultra" });
  await c.next((m) => m.type === "rd_quality_ok");
  c.send({ type: "rd_list" });
  const lst = await c.next((m) => m.type === "rd_list");
  check("quality preset applies", lst.items.find((x) => x.id === sid).quality === "ultra");

  // Unknown session input rejected.
  c.send({ type: "rd_input", sessionId: "nope", inputType: "mouse_move", x: 1, y: 1 });
  const bad = await c.next((m) => m.type === "rd_input_ok");
  check("input to unknown session rejected", bad.ok === false && bad.reason === "no_session");

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
