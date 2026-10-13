// Power actions, called directly; nothing here touches the PC.
import { check, finish } from "./helpers.mjs";
import { run } from "../src/pc_power.js";

// pmset only sleeps the display, which locks nothing unless a password is required at once.
let asked = 0;
const r = await run("lock", { platform: "darwin", lockMac: async () => { asked++; return { ok: true }; } });
check("macOS lock goes through the real screen lock", r.ok && asked === 1);
process.env.RH_POWER_DRY = "1";
check("a dry run names the real lock on macOS", (await run("lock", { platform: "darwin", lockMac: async () => ({ ok: true }) })).dry === "helper");
check("other systems keep their own lock command", (await run("lock", { platform: "win32" })).dry === "rundll32.exe");
finish();
