// `pocketdesk policy`: inspect the four machine-owner keys, or set and reset one of them.
// This file parses and decides who may write; `policy.js` owns both stores and the admin probe.
import { describe, isAdmin, resetKey, setKey } from "./policy.js";

export const USAGE = "pocketdesk policy [--status | set KEY 0|1 | reset [KEY|all]]";

const NEED_ADMIN =
  "changing machine policy needs an elevated shell: open PowerShell as administrator and run it again";

/**
 * One command's result: the lines to print and the exit code. `admin` is injectable so a test can
 * prove both sides of the gate without an elevated terminal; the CLI passes the real probe.
 */
export function runPolicy(argv = [], { admin = isAdmin() } = {}) {
  const [action, key, value] = argv;
  // `--status` is the documented spelling of inspect, so it prints the same read-only lines; a
  // stray argument after it is a typo and must fail instead of being silently dropped.
  if (action === "--status") {
    if (key !== undefined) return { code: 1, out: [USAGE] };
    return { code: 0, out: describe() };
  }
  // Inspect is read-only: it must not create the ProgramData copy just by looking.
  if (!action || action === "inspect" || action === "show") return { code: 0, out: describe() };
  if (action !== "set" && action !== "reset") return { code: 1, out: [USAGE] };
  if (!admin) return { code: 1, out: [`policy: ${NEED_ADMIN}; nothing was written`] };
  try {
    if (action === "set") {
      if (!key || value === undefined) return { code: 1, out: [USAGE] };
      const done = setKey(key, value, { requireAdmin: false });
      return { code: 0, out: [`policy: ${key}=${value} written`, ...done] };
    }
    const name = !key || key === "all" ? null : key;
    const done = resetKey(name, { requireAdmin: false });
    return { code: 0, out: [`policy: ${name || "every key"} reset`, ...done] };
  } catch (e) {
    return { code: 1, out: [`policy: ${e.message}`] };
  }
}
