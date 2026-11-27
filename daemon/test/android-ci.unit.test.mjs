// The emulator job is the only place the Android code ever runs on a device, so its wiring
// has to match the build file: the API levels it tests are minSdk and targetSdk, the runner
// it installs is the one the manifest declares, and there are androidTest sources to run.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, check, finish } from "./helpers.mjs";

const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
const gradle = fs.readFileSync(path.join(REPO, "app", "app", "build.gradle.kts"), "utf8");

const num = (name) => Number(new RegExp(`${name} = (\\d+)`).exec(gradle)?.[1]);
const minSdk = num("minSdk");
const targetSdk = num("targetSdk");
check(
  "the build file declares minSdk and targetSdk",
  Number.isFinite(minSdk) && Number.isFinite(targetSdk),
  `minSdk=${minSdk} targetSdk=${targetSdk}`,
);

// The job block, from its name to the next job at the same indentation.
const start = ci.indexOf("  android-emulator:");
check("ci.yml has an android-emulator job", start > 0);
const rest = ci.slice(start + 1);
const end = rest.search(/\r?\n {2}[a-z-]+:\r?\n/);
const job = end > 0 ? rest.slice(0, end) : rest;

check("the job runs on an emulator runner", /uses: reactivecircus\/android-emulator-runner@v2/.test(job));
check("the job runs the instrumented tests", /connectedDebugAndroidTest/.test(job));
check("the job disables animations (flaky Espresso otherwise)", /disable-animations: true/.test(job));
check(
  "the job uploads its reports even when red",
  /if: always\(\)/.test(job) && /androidTest-results/.test(job),
);

const levels = /api-level: \[([0-9, ]+)\]/.exec(job);
check("the job declares an api-level matrix", levels !== null, levels?.[0]);
if (levels) {
  const api = levels[1].split(",").map((s) => Number(s.trim()));
  check(`the matrix covers minSdk (${minSdk})`, api.includes(minSdk), JSON.stringify(api));
  check(`the matrix covers targetSdk (${targetSdk})`, api.includes(targetSdk), JSON.stringify(api));
}

// The runner class the job's tests need must be the one the app is built with.
const runner = /testInstrumentationRunner = "([^"]+)"/.exec(gradle)?.[1];
check(
  "the app declares an instrumentation runner",
  runner === "androidx.test.runner.AndroidJUnitRunner",
  runner,
);
check(
  "the runner dependency is present",
  /androidx\.test:runner/.test(
    fs.readFileSync(path.join(REPO, "app", "gradle", "libs.versions.toml"), "utf8"),
  ),
);

// And there must be something to run.
const dir = path.join(REPO, "app", "app", "src", "androidTest", "java", "com", "yasha", "pocketdesk");
const tests = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".kt")) : [];
check(`androidTest sources exist (${tests.length} files)`, tests.length > 0, tests.join(", "));
const sources = tests.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
check(
  "they are JUnit4 (what the Android runner executes)",
  /org\.junit\.Test/.test(sources) && !/org\.junit\.jupiter/.test(sources),
);
check("they cover pairing", /class PairingInstrumentedTest/.test(sources));
check("they cover TLS pinning", /class TlsInstrumentedTest/.test(sources) && /pinnedClient/.test(sources));
check("they render the main screens", /class ScreensRenderTest/.test(sources));
check(
  "the emulator job can compose screens",
  /androidTestImplementation\(libs\.compose\.ui\.test\.junit4\)/.test(gradle),
);

// Release identity. versionCode is read from every commit that touched the build file, so a
// reused or rewound number fails here even though nobody keeps a baseline; versionName must have
// a CHANGELOG section, so shipping a version without release notes fails the suite.
const code = Number(/versionCode = (\d+)/.exec(gradle)?.[1]);
const versionName = /versionName = "([^"]+)"/.exec(gradle)?.[1];
check(
  "the build file declares versionCode and versionName",
  Number.isFinite(code) && code > 0 && Boolean(versionName),
  `versionCode=${code} versionName=${versionName}`,
);

const gitFile = (rev) => {
  try {
    return execFileSync("git", ["-C", REPO, "show", `${rev}:app/app/build.gradle.kts`], { encoding: "utf8" });
  } catch {
    return "";
  }
};
const shas = execFileSync("git", ["-C", REPO, "log", "--format=%H", "--", "app/app/build.gradle.kts"], {
  encoding: "utf8",
})
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
const codes = shas
  .map((sha) => Number(/versionCode = (\d+)/.exec(gitFile(sha))?.[1]))
  .filter(Number.isFinite)
  .reverse();
check(`versionCode history was read (${codes.length} changes)`, codes.length >= 10, codes.join(","));
const drops = codes.filter((v, i) => i > 0 && v < codes[i - 1]);
check("versionCode never goes backwards", drops.length === 0, `codes: ${codes.join(",")}`);
check(
  "the build file carries the newest versionCode",
  codes[codes.length - 1] === code,
  `file=${code} newest=${codes[codes.length - 1]}`,
);

const changelog = fs.existsSync(path.join(REPO, "CHANGELOG.md"))
  ? fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8")
  : "";
const heads = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
check("CHANGELOG.md has a release section", heads.length > 0, heads.join(","));
check(
  "the newest section is the versionName in the build file",
  heads[0] === versionName,
  `changelog=${heads[0]} build=${versionName}`,
);
finish();
