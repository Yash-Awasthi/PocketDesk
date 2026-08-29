/**
 * Smoke tests for proposals module.
 * Run with: node test/proposals.test.mjs
 */
import { strict as assert } from "node:assert";
import * as proposals from "../src/proposals.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

console.log("proposals");

// Init
proposals.init(() => {});

test("create returns proposal with id", () => {
  const p = proposals.create({
    type: "command_execute",
    summary: "Run build",
    detail: { command: "npm run build" },
    sessionId: "test-session",
  });
  assert.ok(p.id, "should have id");
  assert.equal(p.type, "command_execute");
  assert.equal(p.status, "pending");
});

test("approve changes status to approved", () => {
  const p = proposals.create({
    type: "file_write",
    summary: "Write config",
    detail: { path: "/tmp/config.json" },
    sessionId: "s1",
  });
  const result = proposals.approve(p.id);
  assert.equal(result.status, "approved");
});

test("reject removes from pending", () => {
  const p = proposals.create({
    type: "network_request",
    summary: "Call API",
    detail: { url: "https://example.com" },
    sessionId: "s2",
  });
  const result = proposals.reject(p.id);
  assert.equal(result.status, "rejected");
  assert.equal(proposals.get(p.id), null, "should be removed");
});

test("listPending returns only pending", () => {
  const p1 = proposals.create({ type: "command_execute", summary: "a", detail: {}, sessionId: "s" });
  const p2 = proposals.create({ type: "command_execute", summary: "b", detail: {}, sessionId: "s" });
  proposals.approve(p1.id);
  const pending = proposals.listPending();
  assert.ok(pending.length >= 1, "should have at least 1 pending");
  assert.ok(!pending.find(p => p.id === p1.id), "approved should not be in pending");
});

test("requiresApproval returns true for command_execute", () => {
  assert.equal(proposals.requiresApproval("command_execute"), true);
  assert.equal(proposals.requiresApproval("file_write"), true);
  assert.equal(proposals.requiresApproval("network_request"), true);
  assert.equal(proposals.requiresApproval("api_call"), false);
});

test("approve nonexistent returns null", () => {
  assert.equal(proposals.approve("nonexistent"), null);
});

test("reject nonexistent returns null", () => {
  assert.equal(proposals.reject("nonexistent"), null);
});

console.log(`\n  ${passed} passing, ${failed} failing`);
process.exit(failed > 0 ? 1 : 0);
