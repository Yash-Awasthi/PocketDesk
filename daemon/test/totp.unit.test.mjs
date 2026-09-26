// Two-factor pairing codes (RFC 6238 test vector plus replay and window rules).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";

process.env.RH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rh-totp-"));
const totp = await import("../src/totp.js");

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" at T=59 s: 94287082 (last six digits).
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
check("matches the RFC 6238 test vector", totp.code(rfcSecret, 1) === "287082");

const now = Date.now();
const step = Math.floor(now / 30000);
check("the current code is accepted", totp.check(rfcSecret, totp.code(rfcSecret, step), now));
check("the same code cannot be used twice", !totp.check(rfcSecret, totp.code(rfcSecret, step), now));
check("a code from two steps ago is refused", !totp.check(rfcSecret, totp.code(rfcSecret, step - 2), now));

check("pairing is open while two-factor is off", totp.allowsPairing(undefined) && !totp.enabled());
const { secret, uri } = totp.setup("pc");
check("setup gives an otpauth link", uri.startsWith("otpauth://totp/") && uri.includes(secret));
check("a wrong code does not enable it", !totp.enable("000000") || totp.code(secret, step) === "000000");
// Each step is spent once, so the checks below walk forward through the window.
check("the right code enables it", totp.enable(totp.code(secret, Math.floor(Date.now() / 30000) - 1)) && totp.enabled());
check("pairing without a code is refused", !totp.allowsPairing(undefined));
check("pairing with a fresh code is allowed", totp.allowsPairing(totp.code(secret, Math.floor(Date.now() / 30000))));
check("disabling needs a code", !totp.disable("123") && totp.enabled());
check("disabling with a code turns it off", totp.disable(totp.code(secret, Math.floor(Date.now() / 30000) + 1)) && !totp.enabled());

fs.rmSync(process.env.RH_HOME, { recursive: true, force: true });
finish();
