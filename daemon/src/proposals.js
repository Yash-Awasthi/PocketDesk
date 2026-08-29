/**
 * Proposal manager for PocketDesk.
 *
 * Inspired by claude-code-hermit's proposal/approval pattern.
 * Agent suggests actions → proposal created → human sees in UI → approve/reject/modify.
 *
 * Proposal types: file_write, command_execute, api_call, network_request
 * TTL: auto-reject after 5 minutes
 */
import crypto from "node:crypto";

/** @type {Map<string, Proposal>} */
const pending = new Map();

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL = 30_000; // check every 30s

/**
 * @typedef {{
 *   id: string,
 *   type: 'file_write' | 'command_execute' | 'api_call' | 'network_request',
 *   summary: string,
 *   detail: object,
 *   sessionId: string,
 *   created: number,
 *   status: 'pending' | 'approved' | 'rejected' | 'modified' | 'expired',
 *   modifiedDetail: object|null,
 *   approvedBy: string|null,
 * }} Proposal
 */

let cleanupTimer = null;
let broadcastFn = null;

/**
 * Initialize the proposal manager.
 * @param {Function} broadcast - broadcast(obj) to all authed clients
 */
export function init(broadcast) {
  broadcastFn = broadcast;
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(expireStale, CLEANUP_INTERVAL);
}

/**
 * Create a proposal.
 * @param {object} opts
 * @param {string} opts.type - file_write | command_execute | api_call | network_request
 * @param {string} opts.summary - human-readable description
 * @param {object} opts.detail - action-specific payload
 * @param {string} opts.sessionId - originating session/chat id
 * @returns {Proposal}
 */
export function create({ type, summary, detail, sessionId }) {
  const id = crypto.randomUUID().slice(0, 8);
  const proposal = {
    id,
    type,
    summary,
    detail,
    sessionId,
    created: Date.now(),
    status: "pending",
    modifiedDetail: null,
    approvedBy: null,
  };
  pending.set(id, proposal);
  if (broadcastFn) {
    broadcastFn({
      type: "proposal_created",
      proposal: serialize(proposal),
    });
  }
  return proposal;
}

/**
 * Approve a proposal.
 * @returns {Proposal|null}
 */
export function approve(id) {
  const p = pending.get(id);
  if (!p || p.status !== "pending") return null;
  p.status = "approved";
  p.approvedBy = "user";
  if (broadcastFn) {
    broadcastFn({
      type: "proposal_approved",
      proposal: serialize(p),
    });
  }
  return p;
}

/**
 * Reject a proposal.
 * @returns {Proposal|null}
 */
export function reject(id) {
  const p = pending.get(id);
  if (!p || p.status !== "pending") return null;
  p.status = "rejected";
  if (broadcastFn) {
    broadcastFn({
      type: "proposal_rejected",
      proposal: serialize(p),
    });
  }
  pending.delete(id);
  return p;
}

/**
 * Get a proposal by id.
 */
export function get(id) {
  return pending.get(id) || null;
}

/**
 * Get all pending proposals.
 */
export function listPending() {
  return [...pending.values()]
    .filter((p) => p.status === "pending")
    .map(serialize);
}

/**
 * Wait for a proposal decision (poll-based with timeout).
 * @param {string} id
 * @param {number} timeoutMs - max wait (default 5 min = TTL)
 * @returns {Promise<{status: string, proposal: Proposal|null}>}
 */
export function waitForDecision(id, timeoutMs = TTL_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const p = pending.get(id);
      if (!p || p.status !== "pending") {
        resolve({ status: p ? p.status : "expired", proposal: p ? serialize(p) : null });
        return;
      }
      if (Date.now() - start > timeoutMs) {
        p.status = "expired";
        pending.delete(id);
        resolve({ status: "expired", proposal: serialize(p) });
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

/**
 * Check if a proposal type requires approval.
 */
export function requiresApproval(type) {
  return ["file_write", "command_execute", "network_request"].includes(type);
}

/**
 * Force-expire stale proposals.
 */
function expireStale() {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (p.status === "pending" && now - p.created > TTL_MS) {
      p.status = "expired";
      pending.delete(id);
      if (broadcastFn) {
        broadcastFn({
          type: "proposal_expired",
          proposal: serialize(p),
        });
      }
    }
  }
}

/**
 * Serialize a proposal for WebSocket transport.
 */
function serialize(p) {
  return {
    id: p.id,
    type: p.type,
    summary: p.summary,
    detail: p.detail,
    sessionId: p.sessionId,
    created: p.created,
    status: p.status,
    ttlRemaining: Math.max(0, TTL_MS - (Date.now() - p.created)),
  };
}
