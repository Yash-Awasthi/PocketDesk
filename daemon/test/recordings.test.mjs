// Recorded terminal sessions can be listed, fetched raw and replayed as text.
// Retention is capped, recording is opt-in, and recorder.js never talks to the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8879;
const CLI_PORT = 46879;
const TOKEN = "rectoken";
const home = makeTmp("rh-rec-");
// recorder.js resolves its dirs from RH_HOME at import time; keep the real profile untouched.
process.env.RH_HOME = home;
const { replayCast, pruneRecordings, Recorder } = await import("../src/recorder.js");

const rec = path.join(home, "recordings");
fs.mkdirSync(rec, { recursive: true });
const cast = '{"version": 2, "width": 80, "height": 24, "timestamp": 1}\n[0.1, "o", "hi\\r\\n"]\n';
fs.writeFileSync(path.join(rec, "shell-1.cast"), cast);
fs.writeFileSync(path.join(rec, "sessions.log"), "{}\n");

// Cursor-only frame, ANSI colour, spinner redraws.
const ansi =
  '{"version": 2, "width": 80, "height": 24, "timestamp": 1}\n' +
  '[0.1, "o", "\\u001b[2J\\u001b[1;1H"]\n' +
  '[0.2, "o", "hello \\u001b[31mworld\\u001b[0m\\r\\n"]\n' +
  '[0.3, "o", "spin\\r|\\r/\\rdone\\r\\n"]\n';
fs.writeFileSync(path.join(rec, "ansi-1.cast"), ansi);
fs.writeFileSync(path.join(rec, "corrupt.cast"), "not json");

/** Wait for a write to land: createWriteStream opens asynchronously. */
async function until(pred, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

try {
  const text = replayCast(ansi);
  check("replay keeps readable text", text.includes("hello world") && text.includes("done"));
  check("replay drops escapes and spinner redraws", !text.includes("\u001b") && !text.includes("spin"));
  let threw = false;
  try {
    replayCast("not json");
  } catch {
    threw = true;
  }
  check("a non-cast file is refused by replay", threw);

  // Recording is opt-in: no flag file, no directory, no media.
  const opt = makeTmp("rh-rec-opt-");
  const optRec = path.join(opt, "recordings");
  const optFlag = path.join(opt, "record-sessions");
  const r = new Recorder({ recordings: optRec, flag: optFlag });
  r.terminalStarted({ id: "off", harnessId: "node", cwd: opt });
  r.terminalOutput("off", "hello");
  r.terminalEnded("off");
  check("no flag means no recording dir", !fs.existsSync(optRec));

  fs.writeFileSync(optFlag, "");
  r.terminalStarted({ id: "on", harnessId: "node", cwd: opt });
  r.terminalOutput("on", "hello");
  r.terminalEnded("on");
  const wrote = await until(
    () => fs.existsSync(optRec) && fs.readdirSync(optRec).some((n) => n.endsWith(".cast")),
  );
  const onFile = wrote ? fs.readdirSync(optRec).find((n) => n.endsWith(".cast")) : null;
  check(
    "the flag turns terminal recording on, inside the injected dir",
    !!onFile && path.resolve(optRec, onFile).startsWith(path.resolve(optRec)),
  );
  fs.rmSync(opt, { recursive: true, force: true });

  const src = fs.readFileSync(new URL("../src/recorder.js", import.meta.url), "utf8");
  check(
    "recorder keeps recordings on the machine",
    !/node:(net|http|https|tls|dgram)/.test(src) && !/new\s+WebSocket/.test(src),
  );

  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, home });
  await d.ready;
  const pc = await openAndHello(PORT, TOKEN);

  pc.send({ type: "recordings_list" });
  const list = await pc.next((m) => m.type === "recordings_list");
  const names = list.items.map((i) => i.name).sort();
  check(
    "terminal recordings are listed, the audit log is not",
    names.length === 3 &&
      names.includes("shell-1.cast") &&
      !names.includes("sessions.log") &&
      list.items.find((i) => i.name === "shell-1.cast").size === cast.length,
  );

  pc.send({ type: "recording_get", name: "shell-1.cast" });
  const got = await pc.next((m) => m.type === "recording_get");
  check("a recording comes back whole", got.name === "shell-1.cast" && got.text === cast);

  pc.send({ type: "recording_get", name: "ansi-1.cast", format: "text" });
  const txt = await pc.next((m) => m.type === "recording_get" && m.name === "ansi-1.cast");
  check(
    "text mode replays readable output",
    typeof txt.text === "string" &&
      txt.text.includes("hello world") &&
      txt.text.includes("done") &&
      !txt.text.includes("\u001b"),
  );

  pc.send({ type: "recording_get", name: "ansi-1.cast" });
  const raw = await pc.next((m) => m.type === "recording_get" && m.name === "ansi-1.cast");
  check("raw mode still returns the file bytes", raw.text === ansi);

  pc.send({ type: "recording_get", name: "corrupt.cast", format: "text" });
  const badText = await pc.next((m) => m.type === "recording_get" && m.name === "corrupt.cast");
  check("a corrupt recording is reported", /invalid recording/.test(badText.error || ""));

  pc.send({ type: "recording_get", name: "../config.json" });
  const bad = await pc.next((m) => m.type === "recording_get" && m.error);
  check("names outside the recordings folder are refused", !bad.text && /no such recording/.test(bad.error));

  await pc.close();

  // Retention, both directions, on synthetic files.
  const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-rec-prune-"));
  const media = ["a.cast", "b.mp4", "c.cast", "d.mp4", "e.cast"];
  media.forEach((n, i) => {
    const f = path.join(pruneDir, n);
    fs.writeFileSync(f, "x");
    const t = new Date(2020, 0, 1 + i);
    fs.utimesSync(f, t, t);
  });
  fs.writeFileSync(path.join(pruneDir, "sessions.log"), "{}\n");
  const gone = pruneRecordings(pruneDir, 3);
  const left = fs.readdirSync(pruneDir).sort();
  check(
    "retention deletes the oldest media and keeps the newest",
    gone.sort().join(",") === "a.cast,b.mp4" && left.join(",") === "c.cast,d.mp4,e.cast,sessions.log",
  );
  check("the audit log survives pruning", fs.existsSync(path.join(pruneDir, "sessions.log")));

  for (const n of ["f.cast", "g.mp4"]) fs.writeFileSync(path.join(pruneDir, n), "x");
  const underCap = pruneRecordings(pruneDir, 5);
  check(
    "a directory at the cap is left alone",
    underCap.length === 0 && fs.readdirSync(pruneDir).length === 6,
  );
  fs.rmSync(pruneDir, { recursive: true, force: true });
} catch (e) {
  check("recordings flow: " + e.message, false);
} finally {
  await teardown(home);
}
finish();
