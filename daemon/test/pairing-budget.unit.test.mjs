// Wrong-token pairing budget: pure backoff rules plus the real daemon refusing a guesser.
import test from "node:test";
import assert from "node:assert/strict";
import * as budget from "../src/pairing_budget.js";
import { connect, makeTmp, startDaemon, teardown } from "./helpers.mjs";

const MIN = 60 * 1000;

test("ten failures are free and the eleventh hello is blocked", () => {
  budget.reset();
  const t = 1_000_000;
  for (let i = 0; i < 10; i++) {
    assert.equal(budget.allowed("ip", t), true, `attempt ${i + 1} is allowed`);
    budget.fail("ip", t);
  }
  assert.equal(budget.allowed("ip", t), false);
  const s = budget.state("ip", t);
  assert.equal(s.failures, 10);
  assert.equal(s.retryIn, 1000);
});

test("the lock doubles from 1s and caps at 300s", () => {
  budget.reset();
  let t = 0;
  for (let i = 0; i < 10; i++) budget.fail("ip", t);
  const delays = [];
  for (let i = 0; i < 12; i++) {
    const s = budget.state("ip", t);
    delays.push(s.retryIn);
    assert.equal(budget.allowed("ip", s.lockedUntil - 1), false);
    assert.equal(budget.allowed("ip", s.lockedUntil), true);
    t = s.lockedUntil;
    budget.fail("ip", t);
  }
  assert.deepEqual(
    delays,
    [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000],
  );
});

test("a correct token clears the count and the lock", () => {
  budget.reset();
  for (let i = 0; i < 10; i++) budget.fail("ip", 0);
  assert.equal(budget.allowed("ip", 0), false);
  budget.succeed("ip");
  assert.equal(budget.allowed("ip", 0), true);
  assert.deepEqual(budget.state("ip", 0), { failures: 0, lockedUntil: 0, retryIn: 0 });
});

test("failures older than 15 minutes are forgotten", () => {
  budget.reset();
  for (let i = 0; i < 10; i++) budget.fail("ip", 0);
  assert.equal(budget.allowed("ip", 0), false);
  const later = 15 * MIN + 1;
  assert.equal(budget.allowed("ip", later), true);
  assert.deepEqual(budget.state("ip", later), { failures: 0, lockedUntil: 0, retryIn: 0 });
  budget.fail("ip", later);
  assert.equal(budget.state("ip", later).failures, 1);
});

test("many keys stay bounded and a locked key survives the sweep", () => {
  budget.reset();
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) budget.fail("attacker", now);
  for (let i = 0; i < 5000; i++) budget.fail(`k${i}`, now);
  let kept = 0;
  for (let i = 0; i < 5000; i++) if (budget.state(`k${i}`, now).failures > 0) kept += 1;
  assert.ok(kept <= 1000, `kept ${kept} keys`);
  assert.equal(budget.state("k0", now).failures, 0);
  assert.equal(budget.state("k4999", now).failures, 1);
  assert.equal(budget.allowed("attacker", now), false);
});

test("the daemon closes wrong-token hellos and blocks the eleventh attempt", async () => {
  const tmp = makeTmp("rh-pairbudget-");
  const PORT = 8845;
  const CLI_PORT = 46845;
  const TOKEN = "pairbudgettoken";
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp, dataDir: ".pocketdesk-pairbudget" });

  async function hello(token) {
    const c = connect(PORT, TOKEN);
    await new Promise((res, rej) => {
      c.ws.on("open", res);
      c.ws.on("error", rej);
    });
    const closed = new Promise((res) =>
      c.ws.once("close", (code, reason) => res({ code, reason: String(reason) })),
    );
    c.send({ type: "hello", token });
    return closed;
  }

  try {
    await d.ready;
    const results = [];
    for (let i = 1; i <= 11; i++) results.push(await hello(`wrong-${i}`));
    for (let i = 0; i < 10; i++) assert.equal(results[i].code, 4003, `attempt ${i + 1} closed with 4003`);
    assert.equal(results[10].code, 4029);
    assert.equal(results[10].reason, "too many attempts");
    // The budget is checked before the token, so even the right token is refused while locked.
    const correct = await hello(TOKEN);
    assert.equal(correct.code, 4029, `a correct token was refused: ${JSON.stringify(correct)}`);
  } finally {
    await teardown(tmp);
  }
});
