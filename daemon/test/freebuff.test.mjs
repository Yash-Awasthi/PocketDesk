// Freebuff control + model selection absorption test — exercises the fb_* and
// model_* protocol surfaces (Freebuff desktop control, per-chat model picks)
// against a sandboxed profile dir and skills dir. No real Freebuff app or
// agent CLI is needed: skills run through the manifest registry, and auth
// surfaces are derived from file state only (the token is never transmitted).
import { check, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = makeTmp("rh-t-");
const fbProfile = path.join(tmp, "fb-profile");
const fbSkills = path.join(tmp, "fb-skills");
fs.mkdirSync(path.join(fbProfile, "Local Storage", "leveldb"), { recursive: true });
fs.mkdirSync(path.join(fbSkills, "hello-skill"), { recursive: true });
fs.writeFileSync(
  path.join(fbProfile, "Preferences"),
  JSON.stringify({ window: { width: 1200 }, some: { nested: { flag: 1 } } }),
);
fs.writeFileSync(path.join(fbSkills, "hello-skill", "SKILL.md"), "# Hello Skill\nSay hello, kindly.\n");

const PORT = 8827;
const CLI_PORT = 46827;
const TOKEN = "fbtoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, {
    token: TOKEN,
    manifests: tmp,
    env: {
      FB_PROFILE_DIR: fbProfile,
      FB_SKILLS_DIRS: fbSkills,
      FB_APP_EXE: path.join(tmp, "no-such-app.exe"),
    },
  });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // ── Status ────────────────────────────────────────────────────────────────
  c.send({ type: "fb_status" });
  const st = await c.next((m) => m.type === "fb_status");
  check("fb_status reports profile + counts", st.profile === fbProfile && st.skillCount === 1 && st.configCount === 1 && typeof st.running === "boolean");

  // ── Configs: allowlist, get, deep-merge set with backup ───────────────────
  c.send({ type: "fb_config_list" });
  const cl = await c.next((m) => m.type === "fb_config_list");
  check("config list shows allowlisted file", cl.items.length === 1 && cl.items[0].name === "Preferences");

  c.send({ type: "fb_config_get", name: "Local State" });
  const missing = await c.next((m) => m.type === "fb_config_get");
  check("config_get rejects missing file", missing.ok === false);

  c.send({ type: "fb_config_get", name: "Preferences" });
  const got = await c.next((m) => m.type === "fb_config_get");
  check("config_get parses content", got.ok === true && got.content.window.width === 1200);

  c.send({ type: "fb_config_set", name: "Preferences", patch: { some: { nested: { flag: 2 } }, added: "x" } });
  const set = await c.next((m) => m.type === "fb_config_set");
  check("config_set deep-merges + backs up", set.ok === true && !!set.backedUp);
  c.send({ type: "fb_config_get", name: "Preferences" });
  const got2 = await c.next((m) => m.type === "fb_config_get");
  check("merge preserved untouched keys", got2.content.window.width === 1200 && got2.content.some.nested.flag === 2 && got2.content.added === "x");

  c.send({ type: "fb_config_get", name: "../../etc/passwd" });
  const trav = await c.next((m) => m.type === "fb_config_get");
  check("traversal rejected", trav.ok === false);

  // ── Skills: list, get, run through a real chat surface ────────────────────
  c.send({ type: "fb_skill_list" });
  const sl = await c.next((m) => m.type === "fb_skill_list");
  check("skill list finds SKILL.md", sl.items.length === 1 && sl.items[0].name === "hello-skill" && sl.items[0].description.includes("Hello Skill"));

  c.send({ type: "fb_skill_get", name: "hello-skill" });
  const sg = await c.next((m) => m.type === "fb_skill_get");
  check("skill_get returns content", sg.ok === true && sg.content.includes("Say hello, kindly."));

  c.send({ type: "fb_skill_get", name: "../secrets" });
  const sgbad = await c.next((m) => m.type === "fb_skill_get");
  check("skill traversal rejected", sgbad.ok === false);

  c.send({ type: "fb_skill_run", name: "hello-skill", harness: "notinstalled-cli" });
  const run = await c.next((m) => m.type === "fb_skill_run");
  check("skill_run reports unknown harness cleanly", run.ok === false && /unknown harness/.test(run.error));

  // ── Auth: status from persisted state (JWT shape), logout with confirm ────
  // A JWT-looking string (three 16+ char segments) in Session Storage flips loggedIn.
  const ssDir = path.join(fbProfile, "Session Storage");
  fs.mkdirSync(ssDir, { recursive: true });
  const fakeJwt = ["x".repeat(20), Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url"), "y".repeat(20)].join(".");
  fs.writeFileSync(path.join(ssDir, "000003.log"), `padding ${fakeJwt} padding`);
  c.send({ type: "fb_auth_status" });
  const au = await c.next((m) => m.type === "fb_auth_status");
  check("auth detects persisted JWT", au.loggedIn === true && au.expiresAt != null);

  c.send({ type: "fb_auth_logout", confirm: "nope" });
  const noConf = await c.next((m) => m.type === "fb_auth_logout");
  check("logout without CLEAR confirm refuses", noConf.ok === false);

  c.send({ type: "fb_auth_logout", confirm: "CLEAR" });
  const out = await c.next((m) => m.type === "fb_auth_logout");
  check("logout clears stores + keeps backups", out.ok === true && out.backups.length === 2 && !fs.existsSync(path.join(fbProfile, "Local Storage", "leveldb")));

  c.send({ type: "fb_auth_status" });
  const au2 = await c.next((m) => m.type === "fb_auth_status");
  check("auth logged out after clear", au2.loggedIn === false);

  // ── App open/quit with a bogus exe ────────────────────────────────────────
  c.send({ type: "fb_app_open" });
  const ao = await c.next((m) => m.type === "fb_app_open");
  check("app_open errors cleanly on missing exe", ao.ok === false && /not found/.test(ao.error));

  // ── Model selection on a real chat ────────────────────────────────────────
  c.send({ type: "chatsession", harness: "claude" });
  const created = await c.next((m) => m.type === "created" && m.kind === "chat");
  const chatId = created.id;
  c.send({ type: "model_list", id: chatId });
  const ml = await c.next((m) => m.type === "model_list");
  check("model_list shows manifest models", ml.ok === true && ml.models.includes("opus") && ml.models.includes("sonnet") && ml.current === null);

  c.send({ type: "chat_model_set", id: chatId, model: "sonnet" });
  const ms = await c.next((m) => m.type === "chat_model_set");
  check("chat_model_set selects model", ms.ok === true && ms.current === "sonnet");

  c.send({ type: "chat_model_set", id: chatId, model: "not-a-model" });
  const msBad = await c.next((m) => m.type === "chat_model_set");
  check("unknown model rejected", msBad.ok === false);

  c.send({ type: "model_list", id: "nope" });
  const mlBad = await c.next((m) => m.type === "model_list");
  check("model_list on missing chat errors", mlBad.ok === false);

  await c.close();
  await teardown(tmp);
  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });