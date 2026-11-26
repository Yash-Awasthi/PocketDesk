// Pinned iroh identity: a saved PC's endpoint id is enforced on every dial, not just
// the connection's own transport authentication. Two local endpoints, no ports needed.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ALPN, IrohClient, startIroh } from "../src/iroh_link.js";

let iroh;
try {
  iroh = await import("@number0/iroh");
} catch {
  console.log("SKIP  @number0/iroh not installed");
  process.exit(0);
}
const { Endpoint, RelayMode, EndpointTicket } = iroh;

const alpn = [...Buffer.from(ALPN)];
const endpoints = [];
const tmpDirs = [];

async function endpoint(alpns = []) {
  const b = Endpoint.builder();
  b.applyMinimal();
  b.relayMode(RelayMode.disabled());
  b.alpns(alpns);
  const ep = await b.bind();
  endpoints.push(ep);
  return ep;
}

function timeout(ms, what) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms);
    t.unref?.();
  });
}

after(async () => {
  for (const ep of endpoints) await ep.close().catch(() => {});
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a dial to the pinned endpoint id opens", async () => {
  const srv = await endpoint([alpn]);
  const clientEp = await endpoint();
  const id = srv.id().toString();
  const ticket = EndpointTicket.fromAddr(srv.addr()).toString();

  const accepted = srv.acceptNext().then(async (inc) => {
    const conn = await (await inc.accept()).connect();
    await conn.acceptBi();
    return conn;
  });

  const client = new IrohClient(clientEp, EndpointTicket, ticket, id);
  await Promise.race([once(client, "open"), timeout(15_000, "open")]);
  assert.equal(client.conn.remoteId().toString(), id);
  assert.equal(client.readyState, 1);
  await accepted;
  const closed = once(client, "close");
  client.close();
  await Promise.race([closed, timeout(5_000, "close")]);
});

test("a dial whose pin does not match the endpoint id is closed, never opened", async () => {
  const srvA = await endpoint([alpn]);
  const srvB = await endpoint();
  const clientEp = await endpoint();
  const idB = srvB.id().toString();
  const ticketA = EndpointTicket.fromAddr(srvA.addr()).toString();

  const accepted = srvA
    .acceptNext()
    .then(async (inc) => (await inc.accept()).connect())
    .catch(() => null);

  const client = new IrohClient(clientEp, EndpointTicket, ticketA, idB);
  let opened = false;
  client.on("open", () => (opened = true));
  client.on("error", () => {});
  const [code, reason] = await Promise.race([once(client, "close"), timeout(5_000, "close")]);
  assert.equal(opened, false);
  assert.equal(code, 4003);
  assert.match(String(reason), /endpoint id mismatch/);
  await accepted;
});

test("startIroh's ticketId reads the endpoint id from a ticket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-iroh-pin-data-"));
  tmpDirs.push(dir);
  const srvA = await endpoint();
  const srvB = await endpoint();
  const idA = srvA.id().toString();
  const idB = srvB.id().toString();
  const ticketA = EndpointTicket.fromAddr(srvA.addr()).toString();
  const ticketB = EndpointTicket.fromAddr(srvB.addr()).toString();

  const daemon = await startIroh({ dir, relays: "off", onConnection() {} });
  try {
    assert.ok(daemon, "@number0/iroh started");
    assert.equal(daemon.ticketId(ticketA), idA);
    assert.equal(daemon.ticketId(ticketB), idB);
  } finally {
    await daemon?.close();
  }
});
