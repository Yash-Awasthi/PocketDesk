// Gated git panel mutations: stage/unstage/commit/branch create only touch the repo
// after the phone approves, and cheap mistakes never reach the phone at all.
// No daemon, no WS: a fake broadcast collects the proposals the phone would see.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { check, finish } from "./helpers.mjs";

// config.js reads RH_HOME at import time, so relocate state before loading the modules.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-git-panel-"));
process.env.RH_HOME = home;

const proposals = await import("../src/proposals.js");
const { default: filesHandlers } = await import("../src/handlers/files.js");

// Broadcast queue: a proposal is only reachable after its proposal_created message.
const queue = [];
const waiting = [];
let createdCount = 0;

function capture(msg) {
  if (msg.type === "proposal_created") createdCount++;
  // A waiter consumes its message: leaving it queued would hand the same proposal
  // to the next wait.
  const i = waiting.findIndex((w) => w.pred(msg));
  if (i >= 0) {
    const [w] = waiting.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(msg);
    return;
  }
  queue.push(msg);
}

function next(pred, timeoutMs = 5000) {
  const i = queue.findIndex(pred);
  if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(w), 1);
      reject(new Error("timed out waiting for a broadcast"));
    }, timeoutMs);
    waiting.push(w);
  });
}

proposals.init(capture);

const sent = [];
const handlers = filesHandlers({
  send(_ws, obj) {
    sent.push(obj);
  },
});
const phone = {};

const dirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function out(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

function lines(cwd, ...args) {
  return out(cwd, ...args)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Wait for the phone-side proposal card, approve it, and wait for the handler reply. */
async function approveAfter(promise) {
  const created = (await next((m) => m.type === "proposal_created")).proposal;
  proposals.approve(created.id);
  await promise;
  return created;
}

/** One full propose->approve cycle; returns the handler reply. */
async function approvedCall(name, args) {
  const before = sent.length;
  const promise = handlers[name](phone, args);
  await approveAfter(promise);
  return sent[before];
}

/** One full propose->reject cycle; returns the handler reply. */
async function rejectedCall(name, args) {
  const before = sent.length;
  const promise = handlers[name](phone, args);
  const created = (await next((m) => m.type === "proposal_created")).proposal;
  proposals.reject(created.id);
  await promise;
  return sent[before];
}

async function main() {
  const parent = tmp("rh-git-panel-repo-");
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  out(repo, "init", "-q");
  out(repo, "config", "user.name", "T");
  out(repo, "config", "user.email", "t@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  out(repo, "add", "a.txt");
  out(repo, "commit", "-q", "-m", "init");

  // 1. Stage is proposed, and the index is untouched until the phone approves.
  fs.appendFileSync(path.join(repo, "a.txt"), "two\n");
  check(
    "stage: a.txt shows as modified before any proposal",
    out(repo, "status", "--porcelain").includes("a.txt"),
  );
  check(
    "stage: a.txt is not staged before any proposal",
    !lines(repo, "diff", "--cached", "--name-only").includes("a.txt"),
  );

  const stagePromise = handlers.git_stage(phone, { cwd: repo, paths: ["a.txt"], sessionId: "s1" });
  const stageCreated = (await next((m) => m.type === "proposal_created")).proposal;
  check("stage: proposal type is command_execute", stageCreated.type === "command_execute");
  check("stage: summary names repo and path", stageCreated.summary === "git stage a.txt in repo");
  check(
    "stage: detail is exactly cwd/op/args",
    JSON.stringify(stageCreated.detail) ===
      JSON.stringify({ cwd: repo, op: "stage", args: { paths: ["a.txt"] } }),
  );
  check("stage: sessionId is the one passed", stageCreated.sessionId === "s1");
  check(
    "stage: index still untouched while pending",
    !lines(repo, "diff", "--cached", "--name-only").includes("a.txt"),
  );
  proposals.approve(stageCreated.id);
  await stagePromise;
  const stageReply = sent[sent.length - 1];
  check("stage: approval replies ok", stageReply.type === "git_stage" && stageReply.ok === true);
  check(
    "stage: index holds exactly a.txt",
    JSON.stringify(lines(repo, "diff", "--cached", "--name-only")) === JSON.stringify(["a.txt"]),
  );

  // 2. A rejection leaves the index exactly as it was.
  fs.writeFileSync(path.join(repo, "b.txt"), "bee\n");
  const rejectReply = await rejectedCall("git_stage", { cwd: repo, paths: ["b.txt"], sessionId: "s1" });
  check("reject: reply is not ok", rejectReply.type === "git_stage" && rejectReply.ok === false);
  check(
    "reject: reply says denied on the phone",
    rejectReply.denied === true && rejectReply.error === "denied on the phone",
  );
  check(
    "reject: b.txt never entered the index",
    !lines(repo, "diff", "--cached", "--name-only").includes("b.txt"),
  );

  // 3. A staged file commits under the phone-approved message.
  const revBefore = Number(out(repo, "rev-list", "--count", "HEAD").trim());
  fs.writeFileSync(path.join(repo, "c.txt"), "see\n");
  const stageC = await approvedCall("git_stage", { cwd: repo, paths: ["c.txt"], sessionId: "s1" });
  check("commit setup: c.txt staged", stageC.ok === true);
  const commitReply = await approvedCall("git_commit", { cwd: repo, message: "add c", sessionId: "s1" });
  check("commit: approval replies ok", commitReply.type === "git_commit" && commitReply.ok === true);
  check(
    "commit: rev count grew by one",
    Number(out(repo, "rev-list", "--count", "HEAD").trim()) === revBefore + 1,
  );
  check("commit: subject is the approved message", out(repo, "log", "-1", "--pretty=%s").trim() === "add c");
  check(
    "commit: reply carries a fresh log",
    Array.isArray(commitReply.log?.commits) && commitReply.log.commits.length >= 1,
  );

  const beforeEmpty = createdCount;
  const emptyIdx = sent.length;
  await handlers.git_commit(phone, { cwd: repo, message: "   ", sessionId: "s1" });
  const emptyReply = sent[emptyIdx];
  check(
    "commit: blank message is refused without a proposal",
    emptyReply.type === "git_commit" && emptyReply.ok === false && createdCount === beforeEmpty,
  );

  // 4. Branch creation is approved first; a second run says the branch already exists.
  fs.rmSync(path.join(repo, "b.txt"));
  check("branch: working tree is clean before asking", out(repo, "status", "--porcelain").trim() === "");
  const branchReply = await approvedCall("git_branch_create", {
    cwd: repo,
    name: "feature-x",
    sessionId: "s1",
  });
  check("branch: approval replies ok", branchReply.type === "git_branch_create" && branchReply.ok === true);
  const current = branchReply.branches?.branches?.find((b) => b.name === "feature-x");
  check("branch: reply lists feature-x as current", Boolean(current) && current.current === true);
  const listedBefore = sent.length;
  await handlers.git_branches(phone, { cwd: repo });
  const listed = sent[listedBefore];
  check(
    "branch: git_branches lists feature-x",
    listed.branches?.some((b) => b.name === "feature-x") === true,
  );
  const againReply = await approvedCall("git_branch_create", {
    cwd: repo,
    name: "feature-x",
    sessionId: "s1",
  });
  check(
    "branch: duplicate is refused after approval",
    againReply.type === "git_branch_create" &&
      againReply.ok === false &&
      /already exists/.test(againReply.error),
  );

  // 5. Unstage is gated too (and is harmless when nothing is staged).
  const unstageReply = await approvedCall("git_unstage", { cwd: repo, paths: ["a.txt"], sessionId: "s1" });
  check("unstage: approval replies ok", unstageReply.type === "git_unstage" && unstageReply.ok === true);

  // 6. A path outside the repo is refused before any proposal reaches the phone.
  const outside = path.join(parent, "outside.txt");
  fs.writeFileSync(outside, "nope\n");
  const beforeOutside = createdCount;
  const outsideIdx = sent.length;
  await handlers.git_stage(phone, { cwd: repo, paths: [outside], sessionId: "s1" });
  const outsideReply = sent[outsideIdx];
  check("outside: refused", outsideReply.type === "git_stage" && outsideReply.ok === false);
  check(
    "outside: error names the path",
    typeof outsideReply.error === "string" && outsideReply.error.includes(outside),
  );
  check("outside: no proposal was created", createdCount === beforeOutside);
  check(
    "outside: file never entered the index",
    !lines(repo, "diff", "--cached", "--name-only").includes("outside.txt"),
  );

  const rootBefore = createdCount;
  const rootIdx = sent.length;
  await handlers.git_stage(phone, { cwd: repo, paths: [repo], sessionId: "s1" });
  const rootReply = sent[rootIdx];
  check(
    "outside: repo root is refused",
    rootReply.type === "git_stage" && rootReply.ok === false && /repository root/.test(rootReply.error),
  );
  check("outside: repo root never reaches the phone", createdCount === rootBefore);

  fs.writeFileSync(path.join(repo, "..notes"), "dots\n");
  const dotReply = await approvedCall("git_stage", { cwd: repo, paths: ["..notes"], sessionId: "s1" });
  check("outside: a file named ..notes is allowed", dotReply.type === "git_stage" && dotReply.ok === true);
  check("outside: ..notes is staged", lines(repo, "diff", "--cached", "--name-only").includes("..notes"));
  const dotUnstage = await approvedCall("git_unstage", { cwd: repo, paths: ["..notes"], sessionId: "s1" });
  check("outside: ..notes unstaged again", dotUnstage.type === "git_unstage" && dotUnstage.ok === true);

  check("outside: index is otherwise empty", lines(repo, "diff", "--cached", "--name-only").length === 0);
}

try {
  await main();
} catch (e) {
  check("git panel: " + e.message, false);
} finally {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  fs.rmSync(home, { recursive: true, force: true });
  finish();
  process.exit(0);
}
