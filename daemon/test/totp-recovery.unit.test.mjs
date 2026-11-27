// TOTP recovery codes, clock-skew window and replay refusal, module level and over /access.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { startDaemon, teardown, waitForHealth } from "./helpers.mjs";

process.env.RH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rh-totp-recovery-"));
const totp = await import("../src/totp.js");

const stepOf = (ms) => Math.floor(ms / 30000);

test("the skew window accepts one step either side and refuses two", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const now = Date.now();
  const step = stepOf(now);
  assert.equal(totp.check(secret, totp.code(secret, step - 1), now), true, "one step behind");
  assert.equal(totp.check(secret, totp.code(secret, step - 1), now), false, "the same code replays");
  assert.equal(totp.check(secret, totp.code(secret, step + 1), now), true, "one step ahead");
  assert.equal(totp.check(secret, totp.code(secret, step + 2), now), false, "two steps ahead is outside the window");
});

test("a used code cannot be replayed", () => {
  const secret = "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U";
  const now = Date.now();
  const code = totp.code(secret, stepOf(now));
  assert.equal(totp.check(secret, code, now), true);
  assert.equal(totp.check(secret, code, now), false);
});

test("enable gives eight recovery codes and each disables two-factor once", () => {
  const { secret } = totp.setup("pc");
  const now = Date.now();
  assert.equal(totp.enable(totp.code(secret, stepOf(now) - 1)), true);
  const codes = totp.takeRecovery();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  assert.equal(totp.takeRecovery(), null, "codes are shown once");
  assert.equal(totp.recover("00000000"), false, "an unknown code changes nothing");
  assert.equal(totp.enabled(), true);
  assert.equal(totp.recover(codes[0]), true);
  assert.equal(totp.enabled(), false, "recovery disables two-factor for re-enrollment");
  assert.equal(totp.recover(codes[0]), false, "a spent recovery code cannot be reused");
});

test("the daemon hands out recovery codes and accepts one over /access", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-totp-e2e-"));
  const PORT = 8846;
  const TOKEN = "totprecovery";
  const post = (route, body) => fetch(`http://127.0.0.1:${PORT}${route}?k=${TOKEN}`, {
    method: "POST", body: JSON.stringify(body),
  }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));

  const d = startDaemon(PORT, 46846, { token: TOKEN, manifests: tmp, dataDir: ".pocketdesk-totprecovery" });
  try {
    await d.ready;
    await waitForHealth(PORT);
    const setup = await post("/access/totp/setup", {});
    assert.ok(setup.secret && setup.uri.startsWith("otpauth://totp/"));

    const enabled = await post("/access/totp/enable", { code: totp.code(setup.secret, stepOf(Date.now())) });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.totpEnabled, true);
    assert.equal(enabled.recovery.length, 8);

    const bad = await post("/access/totp/recover", { code: "not-a-code" });
    assert.equal(bad.status, 400);
    assert.equal(bad.totpEnabled, true);

    const recovered = await post("/access/totp/recover", { code: enabled.recovery[3] });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.totpEnabled, false);

    const again = await post("/access/totp/recover", { code: enabled.recovery[3] });
    assert.equal(again.status, 400);
    assert.equal(again.totpEnabled, false);
  } finally {
    await teardown(tmp);
  }
});
