/**
 * Desktop control tests — the real frame source for the rd_/desktop surface.
 * On Windows: capture produces a real JPEG (sanity-checked header), input
 * helpers respond ok, streaming starts and stops. Elsewhere: every command
 * degrades with unsupported_platform and the daemon stays healthy.
 */
import { check, failureCount, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const IS_WIN = process.platform === "win32";
const tmp = makeTmp("rh-desk-");

const PORT = 8821;
const CLI_PORT = 46821;
const TOKEN = "desktoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Status reflects platform support either way.
  c.send({ type: "desktop_status" });
  const st = await c.next((m) => m.type === "desktop_status");
  check("desktop_status reports support + counters", typeof st.supported === "boolean" && st.clients === 0 && Array.isArray(st.lastFrame) === false);

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

    // Streaming: start → frames arrive as pushes → stop.
    c.send({ type: "desktop_start", quality: 40 });
    const ss = await c.next((m) => m.type === "desktop_started", 20000);
    check("desktop_start ok", ss.ok === true && ss.quality > 0);
    const pushed = await c.next((m) => m.type === "desktop_frame", 20000);
    check("desktop_frame pushed while streaming", Buffer.from(pushed.base64, "base64")[0] === 0xff);
    c.send({ type: "desktop_stop" });
    const sp = await c.next((m) => m.type === "desktop_stopped", 10000);
    check("desktop_stop ok", sp.ok === true);

    // Input round-trips (no throw; real effect not asserted — CI safety).
    c.send({ type: "desktop_key", key: 65 });
    const ik = await c.next((m) => m.type === "desktop_input_ok", 15000);
    check("desktop_key ok", ik.ok === true);
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
