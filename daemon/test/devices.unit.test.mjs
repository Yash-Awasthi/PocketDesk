// Pinned iroh endpoint id, pure unit: no native binding, so CI without @number0/iroh still guards it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-devices-"));
// Absolute, set before the import: devices.js resolves its store at module load.
process.env.POCKETDESK_DATA = tmp;
const devices = await import("../src/devices.js");

const pinOf = (id) => devices.list().find((d) => d.id === id)?.endpointId;

try {
  // An id the registry has never seen cannot be pinned, and is not refused either.
  check("unknown id is allowed", devices.claimEndpoint("nobody", "key-a") === true);
  check("unknown id leaves no device behind", devices.list().every((d) => d.id !== "nobody"));

  devices.register("dev-1", { name: "phone", platform: "android" });
  const token = devices.issueToken("dev-1");

  check("first claim pins the endpoint id", devices.claimEndpoint("dev-1", "key-a") === true && pinOf("dev-1") === "key-a");
  check("the same key is allowed again", devices.claimEndpoint("dev-1", "key-a") === true);
  check("a different key is refused", devices.claimEndpoint("dev-1", "key-b") === false);
  check("the refused key did not overwrite the pin", pinOf("dev-1") === "key-a");

  check("revoke succeeds", devices.revoke("dev-1").ok === true);
  check("revoke clears the pin", pinOf("dev-1") === undefined);
  check("the device token no longer resolves", devices.byToken(token) === null);
  check("a re-pair from a new key is allowed", devices.claimEndpoint("dev-1", "key-c") === true && pinOf("dev-1") === "key-c");
  check("the revoked token still does not resolve", devices.byToken(token) === null);

  // The rule only matters if the daemon calls it before the welcome that re-issues a token.
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const gate = server.indexOf("devices.claimEndpoint(auth.id, ws._irohId)");
  const welcome = server.indexOf("const hi = welcome(");
  check("server gates on claimEndpoint before welcome", gate > 0 && welcome > gate);
  check("a mismatched key closes 4003", server.slice(gate, welcome).includes('ws.close(4003, "device key mismatch")'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
finish();
