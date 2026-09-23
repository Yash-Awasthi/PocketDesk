import { AsyncLocalStorage } from "node:async_hooks";
import { createRelayLink } from "./relay.js";

// Remote peers publish protocol commands wrapped in an `rh` envelope on the
// daemon's channel; the daemon validates the token (same timing-safe check
// as the /ws hello), replays the inner message through the normal handle()
// path via a shim ws object, and pushes every response/broadcast back over
// the channel. No inbound port on the PC — the daemon dials OUT to the
// relay, so this works from any network, VPN-free.
const RELAY_SHIM_MAX = 64;
const RELAY_AUTH_FAIL_WINDOW = 10 * 60_000;
const RELAY_AUTH_FAIL_MAX = 20;

export function createRelayBridge({ authenticate, welcome, handle, detachClient, broadcast }) {
  const relayShims = new Map(); // relay peer connId -> shim ws-like object
  // Brute-force counters, one per relay peer. A single shared counter would let
  // any one source spend the budget for every honest peer on the channel.
  const relayAuthFails = new Map(); // relay peer connId -> { n, at }
  // Request id for the reply being produced right now. Held in async context
  // rather than on the shim, because one shim serves concurrent requests and by
  // the time a handler replies the shim may have seen a later request.
  const relayReqCtx = new AsyncLocalStorage();

  function relayAuthFailsFor(from, now) {
    const rec = relayAuthFails.get(from);
    if (!rec) return null;
    if (now - rec.at > RELAY_AUTH_FAIL_WINDOW) {
      relayAuthFails.delete(from);
      return null;
    }
    return rec;
  }

  // A dropped shim may still be referenced by a subscription list; readyState 3
  // makes every later send() a no-op, so nothing leaks to a revoked peer.
  function dropShim(from) {
    const shim = relayShims.get(from);
    if (!shim) return;
    shim.readyState = 3;
    try {
      detachClient(shim);
    } catch {}
    relayShims.delete(from);
  }

  function relayShimFor(from) {
    const existing = relayShims.get(from);
    if (existing) {
      // Re-insert so Map order tracks recency: eviction below must drop the
      // least recently used shim, and a cache hit is a use.
      relayShims.delete(from);
      relayShims.set(from, existing);
      return existing;
    }
    const s = {
      readyState: 1,
      _authed: false,
      _subs: new Set(),
      _clientId: `relay-${from}`,
      _isRelayShim: true,
      send(str) {
        if (s.readyState !== 1) return;
        let data = str;
        try {
          data = JSON.parse(str);
        } catch {
          /* non-JSON send — forward raw */
        }
        // null when nothing is being answered: stream output driven by a
        // session or chat rather than by a request.
        relaySendTo(from, { rh: true, type: "rhresp", reqId: relayReqCtx.getStore() ?? null, data });
      },
    };
    // Bounded: a peer that auths then silently dies leaves its shim behind
    // (the relay never announces member departures) — evict the oldest.
    if (relayShims.size >= RELAY_SHIM_MAX) dropShim(relayShims.keys().next().value);
    relayShims.set(from, s);
    return s;
  }

  function relaySendTo(to, obj) {
    if (relay.status().connected) relay.sendTo(to, obj);
  }

  /**
   * A failed relay hello answers late, and later the more the channel has
   * failed recently. The per-peer lockout keys on the relay-assigned connId,
   * which an attacker resets just by reconnecting; this throttle has no such
   * handle. It only ever delays a rejection, so it cannot lock anyone out.
   */
  let relayFailStreak = { n: 0, at: 0 };
  function relayRejectDelay() {
    const now = Date.now();
    if (now - relayFailStreak.at > RELAY_AUTH_FAIL_WINDOW) relayFailStreak = { n: 0, at: now };
    relayFailStreak = { n: relayFailStreak.n + 1, at: now };
    // The first couple of rejections answer immediately — a typo should not
    // feel broken. Only a streak pays.
    return Math.min(Math.max(0, relayFailStreak.n - 2) * 250, 3000);
  }

  function onRelayEvent(evt) {
    if (evt.type === "relay_message") {
      let data = evt.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      if (data && data.rh === true && data.type === "rhreq") {
        const shim = relayShimFor(evt.from);
        const reqId = data.reqId ?? null;
        const inner = data.msg || {};
        const now = Date.now();
        // Checked before the token test, because every failed hello returns
        // below and would otherwise never reach it.
        const fails = relayAuthFailsFor(evt.from, now);
        if (fails && fails.n >= RELAY_AUTH_FAIL_MAX) {
          relaySendTo(evt.from, { rh: true, type: "rherr", reqId, error: "too many failed auth attempts" });
          return;
        }
        if (!shim._authed) {
          const auth = authenticate(inner);
          if (!auth) {
            relayAuthFails.set(evt.from, { n: (fails?.n ?? 0) + 1, at: fails?.at ?? now });
            setTimeout(() => relaySendTo(evt.from, { rh: true, type: "rherr", reqId, error: "bad token" }), relayRejectDelay()).unref?.();
            relayShims.delete(evt.from);
            return;
          }
          shim._authed = true;
          shim._clientId = auth.id;
          relayAuthFails.delete(evt.from);
          relaySendTo(evt.from, { rh: true, type: "rhresp", reqId, data: welcome(auth, inner) });
          return;
        }
        relayReqCtx.run(reqId, () => handle(shim, inner)).catch((e) => {
          try {
            shim.send(JSON.stringify({ type: "error", message: `handler error: ${e?.message || e}` }));
          } catch {}
        });
        return;
      }
      // Own echoes / foreign envelopes (rhresp/rhpush/rherr) must never be
      // re-broadcast — broadcast() mirrors to the relay, so echoing an
      // envelope here would loop forever.
      if (data && data.rh === true) return;
      broadcast(evt);
      return;
    }
    if (evt.state === "disconnected" || evt.state === "error") {
      for (const from of [...relayShims.keys()]) dropShim(from);
    }
    broadcast(evt);
  }

  const relay = createRelayLink({ onEvent: onRelayEvent });

  return {
    relay,
    // Addressed per authed peer, never published to the channel: the relay has
    // no auth of its own, so a channel guesser would otherwise read everything.
    pushAuthed(obj) {
      if (!relay.status().connected) return;
      for (const [from, shim] of relayShims) if (shim._authed) relay.sendTo(from, obj);
    },
    dropDevice(clientId) {
      for (const [from, shim] of [...relayShims]) if (shim._clientId === clientId) dropShim(from);
    },
  };
}
