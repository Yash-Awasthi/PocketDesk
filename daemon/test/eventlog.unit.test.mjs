// The Windows Event Log is how a machine owner (or an integrity client) reads PocketDesk's decisions
// without knowing where we keep files. Start and stop must both land, and a machine that refuses the
// write must not break the daemon.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, check, finish } from "./helpers.mjs";
import { EVENT_IDS, eventArguments, logEvent, logEventSync } from "../src/eventlog.js";

check("event ids are the published ones", EVENT_IDS.start === 1000 && EVENT_IDS.stop === 1001);
const args = eventArguments(EVENT_IDS.start, "line one\nline two\t  end");
check(
  "the message is flattened to one line",
  args.join(" ").includes("PocketDesk") && !/\n|\t/.test(args[args.length - 1]),
);
check("a long message is bounded", eventArguments(1000, "x".repeat(5000))[9].length <= 900);
check(
  "the source is PocketDesk in the Application log",
  eventArguments(1001, "m").join(" ") === "/L APPLICATION /T INFORMATION /SO PocketDesk /ID 1001 /D m",
);
check("an empty message still has text", eventArguments(1000, "")[9] === "PocketDesk event");

let calls = [];
const ok = await logEvent(EVENT_IDS.start, "hello", (id, message) => {
  calls.push([id, message]);
  return Promise.resolve(true);
});
if (process.platform === "win32") {
  check(
    "logEvent hands the id and message to the writer",
    ok === true && calls.length === 1 && calls[0][0] === 1000,
  );
} else {
  check("nothing is written off Windows", ok === false && calls.length === 0);
}

// The daemon has to actually call it: a module nobody invokes records nothing.
const daemonSrc = fs.readFileSync(path.join(REPO, "daemon", "src", "daemon.js"), "utf8");
check("the daemon records a start", /logEvent\(EVENT_IDS\.start/.test(daemonSrc));
check("the daemon records a stop before it exits", /logEventSync\(EVENT_IDS\.stop/.test(daemonSrc));

// End to end on Windows: write a real event and read it back with wevtutil.
if (process.platform === "win32") {
  const message = "PocketDesk eventlog test " + process.pid;
  const wrote = logEventSync(EVENT_IDS.start, message);
  check("a real event is written", wrote === true);
  let read;
  try {
    read = execFileSync(
      "wevtutil",
      ["qe", "Application", `/q:*[System[Provider[@Name='PocketDesk']]]`, "/c:5", "/rd:true", "/f:text"],
      { encoding: "utf8", windowsHide: true },
    );
  } catch (e) {
    read = "wevtutil failed: " + e.message;
  }
  check(
    `the event is readable under source PocketDesk${read.includes(message) ? "" : ": " + read.slice(0, 200)}`,
    read.includes(message),
  );
} else {
  console.log("SKIP  the real Event Log round trip needs Windows");
}
finish();
