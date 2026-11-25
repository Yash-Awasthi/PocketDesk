// Both native helpers must be pinned and verified before anything runs them: a tampered
// platform-tools zip used to be unpacked unchecked because the URL was "latest".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { check, finish } from "./helpers.mjs";

// Relocate daemon state before tools.js reads configDir; never touch the real profile.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pocketdesk-tools-"));
process.env.RH_HOME = home;

const { downloadVerified, ensureTools, serverPath, PLATFORM_TOOLS } = await import("../src/phone_adb/tools.js");

const toolsDir = path.join(home, "tools");
fs.mkdirSync(toolsDir, { recursive: true });

// The scrcpy-server preimage is a real release artifact we do not have, so satisfy that step
// with a stub and only exercise platform-tools over the wire.
fs.writeFileSync(serverPath(), "stub scrcpy-server\n");

const payload = Buffer.from("platform-tools zip bytes, served over loopback\n");
const payloadSha = crypto.createHash("sha256").update(payload).digest("hex");
const tamperedPayload = Buffer.from(payload);
tamperedPayload[0] ^= 0xff;

const server = http.createServer((req, res) => {
  const body = req.url === "/good" ? payload : req.url === "/tampered" ? tamperedPayload : null;
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-length": body.length });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// The pinned table itself: versioned URLs only, one sha256 per OS.
const pinned = Object.entries(PLATFORM_TOOLS);
check("three platform-tools builds are pinned", pinned.length === 3, pinned.map(([k]) => k).join(","));
check("no platform-tools URL says latest", pinned.every(([, v]) => !/latest/.test(v.url)), pinned.map(([, v]) => v.url).join(" "));
check("platform-tools URLs are versioned", pinned.every(([, v]) => /platform-tools_r37\.0\.3-/.test(v.url)));
check("platform-tools sha256 values are well formed", pinned.every(([, v]) => /^[0-9a-f]{64}$/.test(v.sha256)));

// Good bytes land at the destination, fully renamed.
const goodDest = path.join(home, "dl", "good.bin");
await downloadVerified(`${base}/good`, goodDest, payloadSha);
check("verified download lands the bytes", fs.readFileSync(goodDest).equals(payload));
check("verified download leaves no .part", !fs.existsSync(`${goodDest}.part`));

// One changed byte is rejected and leaves nothing behind.
const badDest = path.join(home, "dl", "bad.bin");
let mismatch = null;
try { await downloadVerified(`${base}/tampered`, badDest, payloadSha); } catch (e) { mismatch = e; }
check("a one-byte change is rejected", mismatch && /checksum mismatch/.test(mismatch.message), mismatch?.message);
check("rejected download leaves no final file", !fs.existsSync(badDest));
check("rejected download leaves no .part", !fs.existsSync(`${badDest}.part`));

const fakeAdb = path.join(toolsDir, "platform-tools", "adb.exe");
let unpacked = false;
const findAdb = () => (unpacked ? fakeAdb : null);

// ensureTools must verify before unpacking: tampered bytes throw, untar never runs.
let untarCalls = 0;
let threw = null;
try {
  await ensureTools({
    downloadVerified: (url, to, sha) => downloadVerified(`${base}/tampered`, to, sha),
    findAdb,
    untar: () => { untarCalls++; },
  });
} catch (e) { threw = e; }
check("ensureTools rejects tampered platform-tools", threw && /checksum mismatch/.test(threw.message), threw?.message);
check("untar is never called on a tampered zip", untarCalls === 0);
check("nothing was unpacked after the rejection", !fs.existsSync(path.join(toolsDir, "platform-tools")));

// Correct bytes: unpack once, return the discovered adb.
const seen = [];
let goodUntar = 0;
const res = await ensureTools({
  // Local bytes cannot match the real pinned hash, so verify them against their own hash;
  // the URL ensureTools passed is still captured to prove it is the pinned one.
  downloadVerified: (url, to) => { seen.push(url); return downloadVerified(`${base}/good`, to, payloadSha); },
  findAdb,
  untar: () => {
    goodUntar++;
    unpacked = true;
    fs.mkdirSync(path.dirname(fakeAdb), { recursive: true });
    fs.writeFileSync(fakeAdb, "");
  },
});
check("ensureTools unpacks the verified zip exactly once", goodUntar === 1);
check("ensureTools returns the discovered adb", res.adb === fakeAdb, String(res.adb));
check("only platform-tools was downloaded", seen.length === 1, seen.join(" "));
check("the download used the pinned versioned URL", seen[0] === PLATFORM_TOOLS[process.platform].url, String(seen[0]));
check("the download URL does not say latest", !/latest/.test(String(seen[0])));

server.close();
fs.rmSync(home, { recursive: true, force: true });
finish();
process.exit(0);
