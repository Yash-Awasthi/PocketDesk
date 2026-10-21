// Saved agent logins switched on disk, against a throwaway home, editor data dir and vault.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { check, finish } from "./helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-accounts-"));
const at = (...p) => path.join(tmp, ...p);
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
process.env.AH_HOME = at("home");
process.env.AH_USERDATA = at("data");
process.env.PD_ACCOUNTS = at("vault");
const accounts = await import("../src/accounts.js");
const jwt = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
const codexAuth = (email) => JSON.stringify({ tokens: { id_token: jwt(email), refresh_token: email + "-r" } });

try {
  // Codex: the whole auth.json is the login, the email comes from its id token.
  write(at("home", ".codex", "auth.json"), codexAuth("a@x.com"));
  check("codex: signed-in account and its email", (await accounts.list("codex")).email === "a@x.com");
  check("codex: save the current login", (await accounts.save("codex", "Work")).ok);
  write(at("home", ".codex", "auth.json"), codexAuth("b@x.com"));
  const two = await accounts.list("codex");
  check("codex: another login is not the saved one", two.email === "b@x.com" && two.saved.length === 1 && !two.saved[0].current);
  const work = two.saved[0].id;
  check("codex: switching restores the saved login", (await accounts.switchTo("codex", work)).ok &&
    fs.readFileSync(at("home", ".codex", "auth.json"), "utf8") === codexAuth("a@x.com"));
  const after = await accounts.list("codex");
  check("codex: the replaced login was kept, nothing lost", after.saved.length === 2 && after.saved.some((a) => a.email === "b@x.com"));
  check("codex: the restored account shows as current", after.saved.find((a) => a.id === work).current);
  check("no token reaches the phone", !JSON.stringify(after).includes("-r"));
  check("codex: a refreshed token is still the same account", (write(at("home", ".codex", "auth.json"), codexAuth("a@x.com").replace("a@x.com-r", "new")),
    (await accounts.list("codex")).saved.find((a) => a.id === work).current));

  // Claude: logins live as keys inside JSON files; other keys stay untouched.
  write(at("home", ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-1", OTHER: "keep" }, model: "sonnet" }));
  check("claude: save the token login", (await accounts.save("claude", "Personal")).ok);
  const personal = (await accounts.list("claude")).saved[0].id;
  write(at("home", ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-2", OTHER: "keep" }, model: "opus" }));
  await accounts.switchTo("claude", personal);
  const s = JSON.parse(fs.readFileSync(at("home", ".claude", "settings.json"), "utf8"));
  check("claude: switching swaps only the token", s.env.CLAUDE_CODE_OAUTH_TOKEN === "tok-1" && s.env.OTHER === "keep" && s.model === "opus");

  // Cursor: rows of its state.vscdb; refused while the app runs.
  const vscdb = at("data", "Cursor", "User", "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(vscdb), { recursive: true });
  const db = new DatabaseSync(vscdb);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("cursorAuth/cachedEmail", "c@x.com");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("cursorAuth/accessToken", "acc-c");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("other/setting", "keep");
  db.close();
  check("cursor: email read from its rows", (await accounts.list("cursor")).email === "c@x.com");
  await accounts.save("cursor", "C");
  const c = (await accounts.list("cursor")).saved[0].id;
  check("cursor: switching is refused while Cursor runs", !(await accounts.switchTo("cursor", c, () => true)).ok);
  const db2 = new DatabaseSync(vscdb);
  db2.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run("d@x.com", "cursorAuth/cachedEmail");
  db2.prepare("DELETE FROM ItemTable WHERE key = ?").run("cursorAuth/accessToken");
  db2.close();
  check("cursor: switching rewrites only its login rows", (await accounts.switchTo("cursor", c)).ok && (() => {
    const d = new DatabaseSync(vscdb, { readOnly: true });
    const get = (k) => d.prepare("SELECT value FROM ItemTable WHERE key = ?").get(k)?.value;
    const ok = get("cursorAuth/cachedEmail") === "c@x.com" && get("cursorAuth/accessToken") === "acc-c" && get("other/setting") === "keep";
    d.close();
    return ok;
  })());

  check("forget removes a saved account", accounts.forget("cursor", c).ok && !(await accounts.list("cursor")).saved.some((a) => a.id === c));
  check("an unknown agent is refused", !(await accounts.list("nope")).ok);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
finish();
