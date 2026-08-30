import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanOutput,
  looksLikeTmuxWorking,
  looksLikeTmuxWaitingForInput,
  looksLikeCompleted,
  getSessionState,
  TmuxActivityMonitor,
} from "../tmux_activity_monitor.js";

describe("TmuxActivityMonitor", () => {
  describe("cleanOutput", () => {
    it("strips ANSI sequences", () => {
      const input = "\x1B[32mHello\x1B[0m World";
      assert.equal(cleanOutput(input), "Hello World");
    });

    it("handles empty string", () => {
      assert.equal(cleanOutput(""), "");
    });

    it("preserves plain text", () => {
      assert.equal(cleanOutput("Hello World"), "Hello World");
    });
  });

  describe("looksLikeTmuxWorking", () => {
    it("detects working state", () => {
      const output = "Processing files...\nPress Ctrl-C to interrupt";
      assert.equal(looksLikeTmuxWorking(output), true);
    });

    it("returns false for idle", () => {
      const output = "All done!";
      assert.equal(looksLikeTmuxWorking(output), false);
    });

    it("returns false for empty", () => {
      assert.equal(looksLikeTmuxWorking(""), false);
    });
  });

  describe("looksLikeTmuxWaitingForInput", () => {
    it("detects waiting state", () => {
      const output = "Press enter to confirm";
      assert.equal(looksLikeTmuxWaitingForInput(output), true);
    });

    it("returns false for working", () => {
      const output = "Processing...\nPress Ctrl-C to interrupt";
      assert.equal(looksLikeTmuxWaitingForInput(output), false);
    });

    it("returns false for empty", () => {
      assert.equal(looksLikeTmuxWaitingForInput(""), false);
    });
  });

  describe("looksLikeCompleted", () => {
    it("detects completion", () => {
      assert.equal(looksLikeCompleted("Task complete"), true);
    });

    it("detects goal achieved", () => {
      assert.equal(looksLikeCompleted("Goal achieved!"), true);
    });

    it("returns false for working", () => {
      assert.equal(looksLikeCompleted("Working on it..."), false);
    });
  });

  describe("getSessionState", () => {
    it("returns idle for empty", () => {
      assert.equal(getSessionState(""), "idle");
    });

    it("returns working", () => {
      assert.equal(getSessionState("Press Ctrl-C to interrupt"), "working");
    });

    it("returns waiting", () => {
      assert.equal(getSessionState("Press enter to confirm"), "waiting");
    });

    it("returns completed", () => {
      assert.equal(getSessionState("Task complete"), "completed");
    });
  });

  describe("TmuxActivityMonitor class", () => {
    it("tracks session state", () => {
      const monitor = new TmuxActivityMonitor();
      const result = monitor.update("session1", "Working...\nPress Ctrl-C to interrupt");
      assert.equal(result.state, "working");
      assert.equal(monitor.getState("session1"), "working");
    });

    it("detects state changes", () => {
      const monitor = new TmuxActivityMonitor();
      monitor.update("s1", "Working...\nPress Ctrl-C to interrupt");
      const result = monitor.update("s1", "Task complete");
      assert.equal(result.changed, true);
      assert.equal(result.state, "completed");
    });

    it("notifies listeners on change", () => {
      const monitor = new TmuxActivityMonitor();
      let notified = false;
      let newState = "";
      monitor.onStateChange((id, state) => {
        notified = true;
        newState = state;
      });
      monitor.update("s1", "Working...\nPress Ctrl-C to interrupt");
      monitor.update("s1", "Task complete");
      assert.equal(notified, true);
      assert.equal(newState, "completed");
    });

    it("returns idle for unknown session", () => {
      const monitor = new TmuxActivityMonitor();
      assert.equal(monitor.getState("unknown"), "idle");
    });

    it("removes session", () => {
      const monitor = new TmuxActivityMonitor();
      monitor.update("s1", "Working...\nPress Ctrl-C to interrupt");
      monitor.removeSession("s1");
      assert.equal(monitor.getState("s1"), "idle");
    });

    it("get all states", () => {
      const monitor = new TmuxActivityMonitor();
      monitor.update("s1", "Working...\nPress Ctrl-C to interrupt");
      monitor.update("s2", "Task complete");
      const states = monitor.getAllStates();
      assert.equal(states.size, 2);
      assert.equal(states.get("s1"), "working");
      assert.equal(states.get("s2"), "completed");
    });
  });
});
