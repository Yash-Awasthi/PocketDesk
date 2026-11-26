/**
 * Desktop capture + input injection — the missing frame SOURCE for the
 * rd_/vnc_ bridges (the "AnyDesk-style" viewing/control the rd_ protocol
 * always promised but never had a real backend for).
 *
 * Windows-only, zero new npm deps. TWO persistent PowerShell helper processes
 * (JSON-line request/reply over stdin/stdout), split so each process does one
 * job and stays warm — capture and input injection are independent, and a
 * helper that dies only takes its own job down:
 *   • capture helper — System.Drawing CopyFromScreen over the FULL virtual
 *     screen (every monitor) → JPEG temp file → Node reads the file. Fully
 *     managed code, no P/Invoke.
 *   • input helper — SendInput P/Invoke: absolute mouse with virtual-screen
 *     normalization (multi-monitor), clicks, wheel, virtual-key taps with
 *     ctrl/alt/shift, Unicode text via scan codes.
 * Endpoint security products are entitled to flag capture-plus-input, and this
 * module does nothing to avoid that: the daemon is visible, documented and
 * blockable on purpose (see docs/INTEGRITY.md).
 * Helpers are DPI-aware and stay warm, so a click costs microseconds instead
 * of a 1-2s process spawn. Scripts are written to .ps1 files in the config dir and
 * run with -ExecutionPolicy Bypass -File (deterministic quoting).
 *
 * Capture runs on a ~300ms loop ONLY while at least one rd client is
 * attached; zero clients → loop fully stops. Non-Windows degrades cleanly
 * ({ ok:false, reason:"unsupported_platform" }), like tmux on Windows.
 */

export { PsHelper, MacHelper, MacVideoNative, DesktopController } from "./desktop/capture.js";
export { macMonitors, fromFraction, toFraction, centerFor, jpegRect } from "./desktop/topology.js";
