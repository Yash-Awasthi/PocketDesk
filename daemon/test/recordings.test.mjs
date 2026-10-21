// Recorded terminal sessions can be listed and fetched for playback, and nothing outside the recordings folder.
import fs from "node:fs";
import path from "node:path";
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8879;
const CLI_PORT = 46879;
const TOKEN = "rectoken";
const home = makeTmp("rh-rec-");
const rec = path.join(home, "recordings");
fs.mkdirSync(rec, { recursive: true });
const cast = '{"version": 2, "width": 80, "height": 24, "timestamp": 1}\n[0.1, "o", "hi\\r\\n"]\n';
fs.writeFileSync(path.join(rec, "shell-1.cast"), cast);
fs.writeFileSync(path.join(rec, "sessions.log"), "{}\n");

try {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, home });
  await d.ready;
  const pc = await openAndHello(PORT, TOKEN);

  pc.send({ type: "recordings_list" });
  const list = await pc.next((m) => m.type === "recordings_list");
  check("terminal recordings are listed, the audit log is not", list.items.length === 1 && list.items[0].name === "shell-1.cast" && list.items[0].size === cast.length);

  pc.send({ type: "recording_get", name: "shell-1.cast" });
  const got = await pc.next((m) => m.type === "recording_get");
  check("a recording comes back whole", got.name === "shell-1.cast" && got.text === cast);

  pc.send({ type: "recording_get", name: "../config.json" });
  const bad = await pc.next((m) => m.type === "recording_get" && m.error);
  check("names outside the recordings folder are refused", !bad.text && /no such recording/.test(bad.error));

  await pc.close();
} catch (e) {
  check("recordings flow: " + e.message, false);
} finally {
  await teardown(home);
}
finish();
