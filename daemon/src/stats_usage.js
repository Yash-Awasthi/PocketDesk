/**
 * Usage Stats — cost/token dashboards from agent stream events.
 *
 * Absorbed from c9watch / flue / orca / cc-pocket (cost + token readouts per
 * session): the daemon already parses claude-stream-json / codex-json; this
 * module keeps per-session aggregates of the usage fields those formats carry
 * (input_tokens, output_tokens, cache tokens, total_cost_usd) and serves them
 * as a dashboard card. Chat.js reports usage on every parsed event.
 */

const MAX_POINTS = 500;

const usage = new Map(); // sessionId -> { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd, turns, lastUpdated, history:[{t, in, out, cost}] }

export function record(sessionId, u) {
  if (!sessionId) return;
  const entry = usage.get(sessionId) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    turns: 0,
    lastUpdated: 0,
    history: [],
  };
  const inTok = Number(u?.input_tokens ?? u?.inputTokens ?? 0);
  const outTok = Number(u?.output_tokens ?? u?.outputTokens ?? 0);
  const cacheRead = Number(u?.cache_read_input_tokens ?? u?.cacheReadTokens ?? 0);
  const cacheCreate = Number(u?.cache_creation_input_tokens ?? u?.cacheCreateTokens ?? 0);
  const cost = Number(u?.total_cost_usd ?? u?.costUsd ?? 0);
  if (!inTok && !outTok && !cost && !cacheRead && !cacheCreate) return;
  entry.inputTokens += inTok;
  entry.outputTokens += outTok;
  entry.cacheReadTokens += cacheRead;
  entry.cacheCreateTokens += cacheCreate;
  entry.costUsd += cost;
  entry.turns += 1;
  entry.lastUpdated = Date.now();
  entry.history.push({ t: entry.lastUpdated, in: inTok, out: outTok, cost });
  if (entry.history.length > MAX_POINTS) entry.history.shift();
  usage.set(sessionId, entry);
}

export function get(sessionId) {
  const e = usage.get(String(sessionId));
  if (!e) return null;
  const { history, ...rest } = e;
  return { ...rest, points: history.slice(-50) };
}

export function list() {
  return [...usage.entries()].map(([sessionId, e]) => ({
    sessionId,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheCreateTokens: e.cacheCreateTokens,
    costUsd: Number(e.costUsd.toFixed(6)),
    turns: e.turns,
    lastUpdated: e.lastUpdated,
  }));
}

export function totals() {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let costUsd = 0;
  for (const e of usage.values()) {
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cacheReadTokens += e.cacheReadTokens;
    cacheCreateTokens += e.cacheCreateTokens;
    costUsd += e.costUsd;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd: Number(costUsd.toFixed(6)), sessions: usage.size };
}

export function reset(sessionId) {
  if (sessionId) usage.delete(String(sessionId));
  else usage.clear();
}
