// One log format, one folder, one rotation rule. The point of the test is the
// negative half: a token or this account's home folder must never appear in a
// line that a person may paste into a bug report.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";
import { appendLine, dailyFile, record, redact } from "../src/logbook.js";
import logger from "../src/plugins/logger-plugin.js";

const parse = (line) => JSON.parse(line.trim());

// 1. The line shape is the same for every event.
const one = record("message", { type: "pair", remote: "192.0.2.7" }, new Date("2026-11-26T12:00:00Z"));
const parsed = parse(one);
check(
  "one JSON line, ISO ts, event name, then fields",
  parsed.ts === "2026-11-26T12:00:00.000Z" &&
    parsed.event === "message" &&
    parsed.type === "pair" &&
    one.endsWith("\n"),
);

// 2. Secrets go, wherever they sit.
const secrets = record("message", {
  token: "abcdef1234567890",
  nested: { password: "hunter22", pairingToken: "0123456789abcdef" },
  note: "Authorization: Bearer abcdef1234567890ABCDEF",
  query: "token=zzzz9999&x=1",
});
check(
  "token-shaped keys are redacted before writing",
  !secrets.includes("abcdef1234567890") && !secrets.includes("hunter22") && !secrets.includes("zzzz9999"),
);
check("the redaction is visible, not silent", (secrets.match(/<redacted>/g) || []).length >= 5);
check(
  "unknown fields survive a redaction",
  parse(record("message", { type: "fs", path: "/srv/x" })).type === "fs",
);

// 3. The account's home folder is replaced, Windows or POSIX separators alike.
const home = os.homedir();
const before = record("message", { cwd: path.join(home, "projects", "app") });
check("the home folder is replaced with ~", !before.includes(home) && before.includes("~"));
check(
  "an absolute path outside home is left readable",
  record("message", { cwd: "/srv/app" }).includes("/srv/app"),
);
check(
  "redact() also walks nested arrays",
  !JSON.stringify(redact({ list: [{ token: "abcdef" }] })).includes("abcdef"),
);

// 4. Rotation: a small cap keeps a small number of files and loses no line.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-log-"));
const file = path.join(tmp, "logs", "daemon-test.log");
for (let i = 0; i < 40; i++)
  appendLine(file, record("message", { type: "fs", i }), { maxBytes: 240, maxFiles: 3 });
const sizes = [file, file + ".1", file + ".2"].map(
  (f) => fs.statSync(f, { throwIfNoEntry: false })?.size ?? -1,
);
check("the live file honours the size cap", sizes[0] > 0 && sizes[0] <= 240);
check("older files are kept as .1 and .2", sizes[1] > 0 && sizes[2] > 0);
check("no file beyond maxFiles is kept", !fs.existsSync(file + ".3"));
const lines = [file, file + ".1", file + ".2"].flatMap((f) => fs.readFileSync(f, "utf8").trim().split("\n"));
check(
  "every rotated line is still valid JSON",
  lines.every((l) => {
    try {
      parse(l);
      return true;
    } catch {
      return false;
    }
  }),
);
check(
  "the newest line is the last thing written",
  parse(fs.readFileSync(file, "utf8").trim().split("\n").pop()).i === 39,
);

// 5. The logger plugin writes to the profile's logs folder, in that same format, redacted.
const oldHome = process.env.RH_HOME;
process.env.RH_HOME = tmp;
const write = process.stdout.write;
process.stdout.write = () => true;
try {
  logger.init({ config: {} });
  logger.start({ config: { port: 8765 } });
  logger.onMessage(
    {},
    { _remote: "192.0.2.7" },
    { type: "fs", token: "abcdef1234567890", cwd: path.join(home, "secret") },
  );
  logger.stop();
} finally {
  process.stdout.write = write;
  process.env.RH_HOME = oldHome;
}
const logfile = dailyFile(path.join(tmp, "logs"));
const written = fs.existsSync(logfile) ? fs.readFileSync(logfile, "utf8").trim().split("\n") : [];
check("the plugin uses the one logs folder", logfile.startsWith(path.join(tmp, "logs")));
check(
  "start, message and stop are all lines there",
  ["start", "message", "stop"].every((e) => written.some((l) => parse(l).event === e)),
);
check(
  "the plugin's line carries no token and no home path",
  !written.join("").includes("abcdef1234567890") && !written.join("").includes(home),
);
check(
  "the plugin's file is private to the user",
  process.platform === "win32" || (fs.statSync(logfile).mode & 0o777) === 0o600,
);

fs.rmSync(tmp, { recursive: true, force: true });
finish();
