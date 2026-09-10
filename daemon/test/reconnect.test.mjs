/**
 * Relay auto-reconnect tests — the backoff behavior salvaged from the corpus
 * websocket_reconnect_client (client-kt pattern) into the LIVE relay link.
 * Behavioral, not white-box: start a real relay server, kill it, watch the
 * link retry with growing delays, restart it, watch recovery. Fast timers.
 */
import assert from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { RelayServer } from "../src/relay_server.js";
import { createRelayLink } from "../src/relay.js";

let passed = 0;
function ok(name) { passed++; console.log(`  PASS  ${name}`); }

const PORT = 8897;

// ── 1. Connects, survives a server restart, backoff grows, counter resets ──
{
  const events = [];
  const link = createRelayLink({
    onEvent: (e) => events.push(e),
    reconnect: { baseDelay: 50, maxDelay: 400, jitter: false },
  });
  const s1 = new RelayServer(PORT);
  s1.start();
  await sleep(150);
  link.connect(`relay://127.0.0.1:${PORT}`, "reconnect-test");
  await sleep(300);
  assert.strictEqual(link.status().connected, true, "initial connect");

  // Kill the server: link must go disconnected then schedule retries.
  s1.stop();
  await sleep(600);
  assert.strictEqual(link.status().connected, false, "down after server killed");
  assert.strictEqual(link.status().reconnecting, true, "reconnect scheduled");
  const attempts = events.filter((e) => e.type === "relay_state" && e.state === "reconnecting");
  assert.ok(attempts.length >= 2, "multiple retry attempts observed");
  assert.ok(attempts[1].delay > attempts[0].delay, `backoff grows (${attempts[0].delay} → ${attempts[1].delay})`);

  // Restart: link must recover on its own, counter reset.
  const s2 = new RelayServer(PORT);
  s2.start();
  await sleep(1500);
  const st = link.status();
  assert.strictEqual(st.connected, true, "auto-recovered after server restart");
  assert.strictEqual(st.retryCount, 0, "retry counter reset on success");
  ok("kill → exponential retries → restart → auto-recovery");
  link.disconnect();
  s2.stop();
}

// ── 2. Manual disconnect NEVER auto-reconnects ─────────────────────────────
{
  const s = new RelayServer(PORT);
  s.start();
  await sleep(120);
  const events = [];
  const link = createRelayLink({ onEvent: (e) => events.push(e), reconnect: { baseDelay: 50, maxDelay: 200, jitter: false } });
  link.connect(`relay://127.0.0.1:${PORT}`, "reconnect-test");
  await sleep(250);
  assert.strictEqual(link.status().connected, true);
  link.disconnect();
  await sleep(400);
  assert.strictEqual(link.status().connected, false, "stays down");
  assert.strictEqual(link.status().reconnecting, false, "no reconnect timer after manual disconnect");
  assert.ok(!events.some((e) => e.state === "reconnecting"), "no reconnecting events");
  ok("manual disconnect suppresses auto-reconnect");
  s.stop();
}

// ── 3. Reconnect options are honored (maxRetries gives up cleanly) ─────────
{
  const events = [];
  // Nothing listens on this port — every dial errors.
  const link = createRelayLink({
    onEvent: (e) => events.push(e),
    reconnect: { baseDelay: 20, maxDelay: 60, maxRetries: 2, jitter: false },
  });
  link.connect("relay://127.0.0.1:8898", "give-up-test");
  await sleep(700);
  assert.ok(events.some((e) => e.state === "failed"), "reaches failed state after maxRetries");
  ok("maxRetries → clean failed state (no infinite hammering)");
  link.disconnect();
}

console.log(`\nALL PASS (${passed} tests)`);
process.exit(0);
