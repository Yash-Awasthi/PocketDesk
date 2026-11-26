// The capture helper names the route that reads a window, and the display-affinity gate refuses
// what it cannot open instead of pretending. Windows-only: the helper is PowerShell plus GDI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";

const WIN = process.platform === "win32";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-capgate-"));
process.env.RH_HOME = home;
const { DesktopController } = await import("../src/desktop_capture.js");
const { handleCaptureMode } = await import("../src/desktop/capture.js");

if (!WIN) {
  check("probe and gate are Windows-only, so there is nothing to drive here", true);
} else {
  const d = new DesktopController();
  try {
    await d.helperCapture.ensure();
    const probe = await d.helperCapture.cmd({ op: "probe" }, 30000);
    check("probe answers ok", probe.ok === true);
    check(
      `probe lists the live desktop windows (${probe.windows?.length ?? 0})`,
      Array.isArray(probe.windows) && probe.windows.length > 0,
    );
    const w = probe.windows?.[0] || {};
    check(
      "each window carries hwnd, title, pid, process, class, affinity and size",
      typeof w.hwnd === "number" &&
        typeof w.title === "string" &&
        typeof w.pid === "number" &&
        typeof w.process === "string" &&
        typeof w.class === "string" &&
        typeof w.affinity === "string" &&
        typeof w.w === "number" &&
        typeof w.h === "number",
    );
    check(
      "probe reports fullscreen state and a route verdict",
      typeof probe.fullscreen?.d3d === "boolean" &&
        typeof probe.fullscreen?.state === "number" &&
        (probe.routes === null ||
          ["blocked", "usable", "identical_to_desktop"].includes(probe.routes.printwindow?.verdict)),
    );
    check(
      "titles are clipped to 80 characters",
      probe.windows.every((x) => x.title.length <= 80),
    );
    check("no more than 60 windows are listed", probe.windows.length <= 60);

    const bogus = await d.helperCapture.cmd({ op: "gate", action: "on", pid: 999999 }, 30000);
    check(
      "a gate on a pid that does not exist fails cleanly",
      bogus.ok === false && typeof bogus.error === "string" && typeof bogus.win32 === "number",
    );

    const status = await d.helperCapture.cmd({ op: "gate", action: "status", pid: process.pid }, 30000);
    check(
      "status on a process with no gate says nothing to turn off",
      status.ok === true && status.gated === false && status.note === "nothing_to_turn_off",
    );

    const list = await d.captureMode({});
    check(
      "no mode lists auto and then the four rungs, in order",
      list.ok === true &&
        list.current === "auto" &&
        list.modes.map((m) => m.id).join(",") === "auto,printwindow,screen,dxgi,fullscreen" &&
        list.modes.filter((m) => m.current).length === 1,
    );
    check(
      "every mode carries a label and a reason it exists",
      list.modes.every(
        (m) => typeof m.label === "string" && m.label.length > 0 && typeof m.note === "string",
      ),
    );

    const refused = await d.captureMode({ mode: "windowdc" });
    check(
      "a mode that was measured and rejected is refused by name, not tried",
      refused.ok === false &&
        refused.error === "unknown_mode" &&
        refused.attempts === undefined &&
        refused.cause,
    );

    const target = probe.routes !== null ? probe.windows.find((x) => x.affinity !== "none (0)") : null;
    const one = await d.captureMode({ mode: "printwindow", hwnd: target ? target.hwnd : undefined });
    check(
      "one explicit rung reports its own attempt, and either a frame or a named cause",
      one.attempts?.length === 1 &&
        (one.ok
          ? one.frame.w > 0 && typeof one.frame.colours === "number"
          : typeof one.cause?.say === "string" && one.cause.id !== ""),
    );

    const missing = await d.checkCapture({ hwnd: 0x7ffffffe });
    check(
      "the check without a window returns a named cause, not a stack trace",
      missing.ok === false && missing.error === "no_window" && missing.cause?.id === "no_window",
    );

    const routed = await handleCaptureMode(
      { captureMode: async (m) => ({ seen: "list", m }), checkCapture: async () => ({ seen: "check" }) },
      { type: "desktop_capture_check" },
    );
    check("the exported handler sends the check case to checkCapture", routed.seen === "check");

    const plain = await handleCaptureMode(
      { captureMode: async (m) => ({ seen: "mode", m }), checkCapture: async () => ({ seen: "check" }) },
      { type: "desktop_capture", mode: "auto" },
    );
    check("the exported handler sends a plain request to captureMode", plain.seen === "mode" && plain.m.mode === "auto");
  } finally {
    d.helperCapture.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
}
finish();
