// The policy store: the registry key, the ProgramData JSON copy, and the rule that either one set to
// 0 disables the feature. The registry half runs for real against HKCU (no admin needed) through the
// same env override the installer and the CLI use.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { check, finish, failureCount } from "./helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-policy-"));
const json = path.join(tmp, "policy.json");
const reg = `HKCU\\SOFTWARE\\PocketDesk\\PolicyTest-${process.pid}`;
process.env.RH_POLICY_REG = reg;
process.env.RH_POLICY_JSON = json;

const policy = await import("../src/policy.js");

function regDeleteAll() {
  for (const name of policy.POLICY_KEYS) {
    try {
      execFileSync("reg", ["delete", reg, "/v", name, "/f"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* absent */
    }
  }
}
function cleanup() {
  regDeleteAll();
  try {
    execFileSync("reg", ["delete", reg, "/f"], { stdio: "ignore", windowsHide: true });
  } catch {
    /* absent */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

try {
  // 1. No store at all: every key on, so a machine without a policy is unchanged.
  regDeleteAll();
  fs.rmSync(json, { force: true });
  {
    const st = policy.currentPolicy({ fresh: true });
    check(
      "no policy means every key is on",
      policy.POLICY_KEYS.every((k) => st[k].allowed),
    );
    check(
      "an unset key names no source",
      policy.POLICY_KEYS.every((k) => st[k].source === undefined),
    );
  }

  // 2. Registry 0, one key at a time, read back through `reg query` for real.
  for (const name of policy.POLICY_KEYS) {
    regDeleteAll();
    fs.rmSync(json, { force: true });
    execFileSync("reg", ["add", reg, "/v", name, "/t", "REG_DWORD", "/d", "0", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const st = policy.currentPolicy({ fresh: true });
    check(`registry ${name}=0 turns that key off`, st[name].allowed === false);
    check(`registry ${name}=0 names the registry key`, String(st[name].source).includes(reg));
    check(
      `registry ${name}=0 leaves the other three on`,
      policy.POLICY_KEYS.filter((k) => k !== name).every((k) => st[k].allowed),
    );
  }

  // 3. The JSON copy alone, one key at a time.
  regDeleteAll();
  for (const name of policy.POLICY_KEYS) {
    fs.writeFileSync(json, JSON.stringify({ [name]: 0 }));
    const st = policy.currentPolicy({ fresh: true });
    check(`policy.json ${name}=0 turns that key off`, st[name].allowed === false);
    check(`policy.json ${name}=0 names the file`, st[name].source === json);
  }

  // 4. The stricter store wins, and 1 in the other store does not re-enable it.
  fs.writeFileSync(json, JSON.stringify({ AllowWebcam: 0 }));
  execFileSync("reg", ["add", reg, "/v", "AllowWebcam", "/t", "REG_DWORD", "/d", "1", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  {
    const st = policy.currentPolicy({ fresh: true });
    check("registry 1 does not override policy.json 0", st.AllowWebcam.allowed === false);
    check("the refusal names policy.json", st.AllowWebcam.source === json);
  }
  // 5. Both stores at 1 is an explicit on.
  execFileSync("reg", ["add", reg, "/v", "AllowWebcam", "/t", "REG_DWORD", "/d", "1", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  fs.writeFileSync(json, JSON.stringify({ AllowWebcam: 1 }));
  {
    const st = policy.currentPolicy({ fresh: true });
    check("both stores at 1 allow the feature", st.AllowWebcam.allowed === true);
    check("an explicit 1 is reported as set", st.AllowWebcam.value === 1);
  }

  // 6. Junk in the file is not a policy and must not crash a read.
  fs.writeFileSync(json, "{ not json");
  check(
    "a corrupt policy.json reads as no policy",
    policy.currentPolicy({ fresh: true }).AllowWebcam.allowed,
  );
  fs.writeFileSync(json, JSON.stringify({ AllowWebcam: "yes", AllowClipboard: 0 }));
  {
    const st = policy.currentPolicy({ fresh: true });
    check("a non-numeric value is ignored", st.AllowWebcam.allowed === true);
    check("a numeric string 0 is honoured", st.AllowClipboard.allowed === false);
  }

  // 7. The reg query table is parsed by name, not by position.
  const table = [
    "",
    "HKEY_CURRENT_USER\\SOFTWARE\\PocketDesk\\PolicyTest",
    "    AllowWebcam    REG_DWORD    0x0",
    "    AllowClipboard    REG_DWORD    0x1",
    "",
  ].join("\r\n");
  check("parseRegQuery reads 0x0 as 0", policy.parseRegQuery(table, "AllowWebcam") === 0);
  check("parseRegQuery reads 0x1 as 1", policy.parseRegQuery(table, "AllowClipboard") === 1);
  check(
    "parseRegQuery returns undefined for an absent name",
    policy.parseRegQuery(table, "AllowPhoneControl") === undefined,
  );

  // 8. Set and reset, per key, through the store the CLI uses.
  regDeleteAll();
  fs.rmSync(json, { force: true });
  for (const name of policy.POLICY_KEYS) {
    policy.setKey(name, 0, { requireAdmin: false });
    check(
      `setKey ${name}=0 is visible at once`,
      policy.currentPolicy({ fresh: true })[name].allowed === false,
    );
    check(`setKey ${name}=0 wrote policy.json`, policy.jsonValues()[name] === 0);
    check(`setKey ${name}=0 wrote the registry`, policy.registryValues()[name] === 0);
    policy.resetKey(name, { requireAdmin: false });
    check(`resetKey ${name} turns it back on`, policy.currentPolicy({ fresh: true })[name].allowed === true);
  }
  policy.setKey("AllowWebcam", 0, { requireAdmin: false });
  policy.setKey("AllowClipboard", 0, { requireAdmin: false });
  policy.resetKey(null, { requireAdmin: false });
  check(
    "resetKey with no name clears every key",
    policy.POLICY_KEYS.every((k) => policy.currentPolicy({ fresh: true })[k].allowed),
  );
  check("resetKey with no name empties policy.json", Object.keys(policy.jsonValues()).length === 0);

  // 9. Guards.
  let threw = null;
  try {
    policy.setKey("AllowEverything", 0, { requireAdmin: false });
  } catch (e) {
    threw = e;
  }
  check("an unknown key is refused", /not a policy key/.test(threw?.message || ""));
  threw = null;
  try {
    policy.setKey("AllowWebcam", 7, { requireAdmin: false });
  } catch (e) {
    threw = e;
  }
  check("a value other than 0 or 1 is refused", /must be 0 or 1/.test(threw?.message || ""));

  // 10. The lines --status and `pocketdesk policy` print.
  policy.setKey("AllowPhoneControl", 0, { requireAdmin: false });
  {
    const lines = policy.describe();
    check(
      "describe covers all four keys",
      lines.length === 4 && policy.POLICY_KEYS.every((k) => lines.some((l) => l.startsWith(k + ":"))),
    );
    check(
      "describe says OFF and where for a disabled key",
      lines.includes(`AllowPhoneControl: OFF (set to 0 in ${json} | ${reg})`) ||
        lines.some((l) => l.startsWith("AllowPhoneControl: OFF (set to 0 in")),
    );
    check(
      "describe says on for an untouched key",
      lines.some((l) => l.startsWith("AllowWebcam: on")),
    );
  }
  // 11. `pocketdesk policy`: inspect writes nothing, set/reset per key, and the admin gate.
  const { runPolicy, USAGE } = await import("../src/policy_cli.js");
  regDeleteAll();
  fs.rmSync(json, { force: true });
  {
    const r = runPolicy([], { admin: false });
    check(
      "policy prints one line per key",
      r.code === 0 &&
        r.out.length === policy.POLICY_KEYS.length &&
        policy.POLICY_KEYS.every((k) => r.out.some((l) => l.startsWith(k + ":"))),
    );
    check("policy inspect creates no policy.json", !fs.existsSync(json));
  }
  {
    const bare = runPolicy([], { admin: false });
    const status = runPolicy(["--status"], { admin: false });
    check(
      "policy --status prints the same lines as bare policy",
      status.code === bare.code && JSON.stringify(status.out) === JSON.stringify(bare.out),
    );
    check("policy --status creates no policy.json", !fs.existsSync(json));
    const stray = runPolicy(["--status", "extra"], { admin: false });
    check(
      "policy --status refuses a stray argument",
      stray.code === 1 && JSON.stringify(stray.out) === JSON.stringify([USAGE]),
    );
  }
  {
    const r = runPolicy(["set", "AllowWebcam", 0], { admin: false });
    const text = r.out.join(" ");
    check("a non-admin set is refused with the reason", r.code === 1 && /administrator/.test(text));
    check(
      "the refused set wrote nothing",
      !fs.existsSync(json) && policy.registryValues().AllowWebcam === undefined,
    );
    const rr = runPolicy(["reset", "all"], { admin: false });
    check("a non-admin reset is refused too", rr.code === 1 && /nothing was written/.test(rr.out.join(" ")));
  }
  for (const name of policy.POLICY_KEYS) {
    const set = runPolicy(["set", name, "0"], { admin: true });
    check(
      `policy set ${name} 0 writes both stores`,
      set.code === 0 &&
        policy.currentPolicy({ fresh: true })[name].allowed === false &&
        policy.jsonValues()[name] === 0 &&
        policy.registryValues()[name] === 0,
    );
    const reset = runPolicy(["reset", name], { admin: true });
    check(
      `policy reset ${name} turns it back on`,
      reset.code === 0 &&
        policy.currentPolicy({ fresh: true })[name].allowed === true &&
        !(name in policy.jsonValues()) &&
        policy.registryValues()[name] === undefined,
    );
  }
  runPolicy(["set", "AllowWebcam", "0"], { admin: true });
  runPolicy(["set", "AllowClipboard", "0"], { admin: true });
  {
    const r = runPolicy(["reset", "all"], { admin: true });
    check(
      "policy reset all clears every key",
      r.code === 0 &&
        policy.POLICY_KEYS.every((k) => policy.currentPolicy({ fresh: true })[k].allowed) &&
        Object.keys(policy.jsonValues()).length === 0,
    );
  }
  {
    const bad = runPolicy(["set", "AllowEverything", "0"], { admin: true });
    check("policy set refuses an unknown key", bad.code === 1 && /not a policy key/.test(bad.out.join(" ")));
    const seven = runPolicy(["set", "AllowWebcam", "7"], { admin: true });
    check(
      "policy set refuses a value other than 0 or 1",
      seven.code === 1 && /must be 0 or 1/.test(seven.out.join(" ")),
    );
    const usage = runPolicy(["frobnicate"], { admin: true });
    check("policy names its usage", usage.code === 1 && usage.out.includes(USAGE));
  }
  // The real entrypoint: index.js routes "policy", and a non-elevated shell is refused end to end.
  regDeleteAll();
  fs.rmSync(json, { force: true });
  {
    const daemonDir = path.resolve(import.meta.dirname, "..");
    const run = (args) => {
      try {
        return {
          code: 0,
          out: execFileSync(process.execPath, ["src/index.js", ...args], {
            cwd: daemonDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        };
      } catch (e) {
        return { code: e.status ?? -1, out: `${e.stdout || ""}${e.stderr || ""}` };
      }
    };
    const inspect = run(["policy"]);
    check(
      "the real CLI prints the policy and exits 0",
      inspect.code === 0 && policy.POLICY_KEYS.every((k) => inspect.out.includes(k + ":")),
    );
    if (policy.isAdmin()) {
      console.log("note: this shell is elevated, so the end-to-end refusal cannot be shown here");
    } else {
      const refused = run(["policy", "set", "AllowWebcam", "0"]);
      check(
        "the real CLI refuses set without admin",
        refused.code === 1 && /administrator/.test(refused.out) && !fs.existsSync(json),
      );
    }
  }
} finally {
  cleanup();
}

if (failureCount()) finish();
else {
  console.log("ALL PASS");
  process.exit(0);
}
