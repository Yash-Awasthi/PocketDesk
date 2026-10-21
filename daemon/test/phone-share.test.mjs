// The PC views and controls the phone: the phone's video reaches watchers, input reaches the phone only while shared.
import { check, connect, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8871;
const CLI_PORT = 46871;
const TOKEN = "phonetoken";
const tmp = makeTmp("rh-phone-");

async function phoneHello() {
  const c = connect(PORT, TOKEN);
  await new Promise((res, rej) => { c.ws.on("open", res); c.ws.on("error", rej); });
  c.send({ type: "hello", token: TOKEN, platform: "android", name: "test phone" });
  await c.next((m) => m.type === "welcome");
  return c;
}

/** Collects binary frames a socket receives. */
function binaries(c) {
  const got = [];
  c.ws.on("message", (raw, isBinary) => { if (isBinary) got.push(Buffer.from(raw)); });
  return got;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const pc = await openAndHello(PORT, TOKEN);
  const other = await openAndHello(PORT, TOKEN);
  const phone = await phoneHello();
  const pcVideo = binaries(pc);

  pc.send({ type: "phone_input", kind: "tap", fx: 0.5, fy: 0.5 });
  check("input before any share is refused", /not shared/.test((await pc.next((m) => m.type === "error")).message));

  pc.send({ type: "phone_watch" });
  check("watching asks the phone to share", !!(await phone.next((m) => m.type === "phone_share_request")));
  check("watch reply says nothing is shared yet", (await pc.next((m) => m.type === "phone_state")).sharing === false);

  phone.send({ type: "phone_share_start", w: 1264, h: 2780 });
  const started = await pc.next((m) => m.type === "phone_started");
  check("watcher learns the phone screen size", started.w === 1264 && started.h === 2780);
  check("every client hears the swap", (await other.next((m) => m.type === "swap")).direction === "pc");

  for (const kind of [0, 1, 2]) phone.ws.send(Buffer.from([kind, 0, 0, 0, 1, 9]));
  other.ws.send(Buffer.from([1, 7, 7]));
  await wait(300);
  check("phone video reaches the watcher as kinds 16-18", pcVideo.map((b) => b[0]).join() === "16,17,18");
  check("video from a socket that is not sharing is ignored", pcVideo.every((b) => b[1] !== 7));
  // A rooted phone adds live panes: slot n sends kinds 4n..4n+2; slots past 3 are dropped.
  for (const b of [4, 5, 6, 13, 16]) phone.ws.send(Buffer.from([b, 0, 0, 0, 1, 9]));
  await wait(300);
  check("pane video keeps its slot", pcVideo.slice(3).map((b) => b[0]).join() === "20,21,22,29");

  pc.send({ type: "phone_input", kind: "tap", fx: 0.25, fy: 0.75 });
  const tap = await phone.next((m) => m.type === "phone_input");
  check("watcher input reaches the phone", tap.kind === "tap" && tap.fx === 0.25 && tap.fy === 0.75);
  pc.send({ type: "phone_input", kind: "tap", fx: 0.5, fy: 0.5, slot: 2 });
  check("pane input keeps its slot", (await phone.next((m) => m.type === "phone_input" && m.slot != null)).slot === 2);
  other.send({ type: "phone_input", kind: "key", key: "home" });
  check("input from a socket that is not watching is refused", /not watching/.test((await other.next((m) => m.type === "error")).message));

  phone.send({ type: "phone_apps", apps: [{ pkg: "com.google.android.gm", label: "Gmail" }, { pkg: "com.google.android.apps.maps", label: "Maps" }] });
  check("recent apps reach the watcher", (await pc.next((m) => m.type === "phone_apps")).apps.length === 2);
  phone.send({ type: "phone_apps", apps: [{ pkg: "a", label: "A", slot: 1 }, { pkg: "b", label: "B", slot: 9 }] });
  const slots = (await pc.next((m) => m.type === "phone_apps" && m.apps[0]?.pkg === "a")).apps.map((a) => a.slot);
  check("live panes name their slot, bad slots are dropped", slots[0] === 1 && slots[1] === undefined);
  pc.send({ type: "phone_switch", pkg: "com.google.android.apps.maps" });
  check("an app switch reaches the phone", (await phone.next((m) => m.type === "phone_switch")).pkg === "com.google.android.apps.maps");

  other.send({ type: "phone_watch" });
  check("a new watcher asks the phone for a keyframe", !!(await phone.next((m) => m.type === "phone_keyframe")));

  pc.send({ type: "phone_fs", op: "list", path: "/DCIM", rid: 7 });
  const ask = await phone.next((m) => m.type === "phone_fs");
  check("a storage request reaches the phone", ask.op === "list" && ask.path === "/DCIM");
  phone.send({ type: "phone_fs_result", rid: ask.rid, items: [{ name: "Camera", dir: true }] });
  const got = await pc.next((m) => m.type === "phone_fs_result");
  check("the phone's answer goes back to the asker with its own id", got.rid === 7 && got.items[0].name === "Camera");
  other.send({ type: "phone_fs_result", rid: ask.rid, items: [] });
  pc.send({ type: "phone_fs", op: "list", path: "/", rid: 8 });
  const again = await phone.next((m) => m.type === "phone_fs" && m.path === "/");
  other.send({ type: "phone_fs_result", rid: again.rid, items: [{ name: "forged" }] });
  await wait(300);
  phone.send({ type: "phone_fs_result", rid: again.rid, items: [{ name: "real" }] });
  check("only the phone can answer", (await pc.next((m) => m.type === "phone_fs_result" && m.rid === 8)).items[0].name === "real");
  const phone2 = await phoneHello();
  pc.send({ type: "phone_fs", op: "list", path: "/x", rid: 10 });
  const ask2 = await phone.next((m) => m.type === "phone_fs" && m.path === "/x");
  phone2.send({ type: "phone_fs_result", rid: ask2.rid, items: [{ name: "forged" }] });
  await wait(300);
  phone.send({ type: "phone_fs_result", rid: ask2.rid, items: [{ name: "asked" }] });
  check("another phone cannot answer for the one asked", (await pc.next((m) => m.type === "phone_fs_result" && m.rid === 10)).items[0].name === "asked");
  await phone2.close();

  pc.send({ type: "phone_share_end" });
  check("swapping back from the PC stops the phone", !!(await phone.next((m) => m.type === "phone_share_stop")));
  check("watchers hear the share ended", !!(await other.next((m) => m.type === "phone_stopped")));
  check("the swap goes back to the phone", (await pc.next((m) => m.type === "swap")).direction === "phone");

  phone.send({ type: "phone_share_start", w: 1080, h: 2400 });
  await pc.next((m) => m.type === "phone_started");
  await wait(3200);
  other.send({ type: "phone_watch" });
  check("a share that sent no video for 3 s is over", (await other.next((m) => m.type === "phone_state")).sharing === false);
  check("and the phone is asked again", !!(await phone.next((m) => m.type === "phone_share_request")));
  phone.send({ type: "phone_share_start", w: 1080, h: 2400 });
  await pc.next((m) => m.type === "phone_started");
  await phone.close();
  check("a phone that drops ends the share", !!(await pc.next((m) => m.type === "phone_stopped")));
  pc.send({ type: "phone_fs", op: "list", path: "/", rid: 9 });
  check("storage without a phone connected says so", /not connected/.test((await pc.next((m) => m.type === "phone_fs_result" && m.rid === 9)).error));

  await pc.close();
  await other.close();
} catch (e) {
  check("phone share flow: " + e.message, false);
} finally {
  await teardown(tmp);
}
finish();
