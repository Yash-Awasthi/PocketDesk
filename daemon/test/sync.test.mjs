// File sync engine absorption test — exercises the sync_* protocol surface
// (syncthing inspiration): device + folder registration, file add/sync,
// conflict detection + resolution, event log, stats, and live sync_event
// broadcasts. Fully in-memory — deterministic, no external processes.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-t-");

const PORT = 8807;
const TOKEN = "testtoken";
const CLI_PORT = 46807;

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Device + folder registration.
  c.send({ type: "sync_device_add", name: "phone", hostname: "pixel", addresses: ["192.168.1.5"] });
  const devices = await c.next((m) => m.type === "sync_devices");
  check("sync_device_add registers device", devices.items.length === 1 && devices.items[0].name === "phone" && devices.items[0].isOnline === true);

  // Register the live-broadcast waiter BEFORE the trigger: the folder:created
  // sync_event is pushed the moment the folder is created, so a waiter set up
  // later would only ever see it in the past.
  const folderBcastP = c.next((m) => m.type === "sync_event" && m.event === "created" && m.label === "docs");
  c.send({ type: "sync_folder_add", label: "docs", path: "C:/docs", devices: [devices.items[0].id] });
  const folders = await c.next((m) => m.type === "sync_folders");
  const folderBcast = await folderBcastP;
  const folderId = folders.items[0].id;
  check("sync_folder_add creates folder", folders.items.length === 1 && folders.items[0].label === "docs");
  check("sync_event broadcast reaches client", !!folderBcast);

  // Files: add two, sync one.
  c.send({ type: "sync_file_add", folderId, path: "a.txt", size: 10 });
  await c.next((m) => m.type === "sync_file_added" && m.path === "a.txt");
  c.send({ type: "sync_file_add", folderId, path: "b.txt", size: 20 });
  await c.next((m) => m.type === "sync_file_added" && m.path === "b.txt");

  c.send({ type: "sync_file_synced", folderId, path: "a.txt", deviceId: "dev-1" });
  const synced = await c.next((m) => m.type === "sync_file_synced" && m.path === "a.txt");
  check("sync_file_synced acks", synced.ok === true);

  c.send({ type: "sync_stats" });
  const stats = await c.next((m) => m.type === "sync_stats");
  check("sync_stats counts synced/pending", stats.totalFiles === 2 && stats.syncedFiles === 1 && stats.totalDevices === 1);

  // Conflict on b.txt → resolve.
  c.send({ type: "sync_conflict", folderId, path: "b.txt", deviceId1: "dev-1", deviceId2: "dev-2" });
  const conflict = await c.next((m) => m.type === "sync_conflict" && m.path === "b.txt");
  check("sync_conflict detected", conflict.ok === true);
  c.send({ type: "sync_stats" });
  const conflicted = await c.next((m) => m.type === "sync_stats");
  check("conflict shows in stats", conflicted.conflicts === 1);

  c.send({ type: "sync_conflict_resolve", folderId, path: "b.txt", keepDeviceId: "dev-1" });
  const resolved = await c.next((m) => m.type === "sync_conflict_resolved" && m.path === "b.txt");
  check("sync_conflict_resolve acks", resolved.ok === true);

  // Events log covers the whole lifecycle.
  c.send({ type: "sync_events" });
  const events = await c.next((m) => m.type === "sync_events");
  const types = events.items.map((e) => e.type);
  check("sync_events records lifecycle", types.includes("file_synced") && types.includes("file_conflict"));

  // Files listing.
  c.send({ type: "sync_files", folderId });
  const files = await c.next((m) => m.type === "sync_files");
  check("sync_files lists folder contents", files.items.length === 2 && files.label === "docs");

  // Unknown folder id → empty, no crash.
  c.send({ type: "sync_files", folderId: "nope" });
  const none = await c.next((m) => m.type === "sync_files");
  check("sync_files unknown folder is empty", none.items.length === 0);

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });