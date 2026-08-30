import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSlashCommand,
  isSlashCommand,
  getSlashQuery,
  filterCommands,
  findCommand,
  executeCommand,
  BUILT_IN_COMMANDS,
} from "../slash_command_parser.js";

describe("SlashCommandParser", () => {
  describe("parseSlashCommand", () => {
    it("parses simple command", () => {
      const result = parseSlashCommand("/status");
      assert.deepEqual(result, { name: "status", args: "", cursorPos: 7 });
    });

    it("parses command with args", () => {
      const result = parseSlashCommand("/send session1 hello world");
      assert.equal(result.name, "send");
      assert.equal(result.args, "session1 hello world");
    });

    it("returns null for non-slash", () => {
      assert.equal(parseSlashCommand("hello"), null);
    });

    it("returns null for empty", () => {
      assert.equal(parseSlashCommand(""), null);
    });

    it("handles cursor position", () => {
      const result = parseSlashCommand("/status extra", 7);
      assert.equal(result.args, "");
    });
  });

  describe("isSlashCommand", () => {
    it("returns true for slash", () => {
      assert.equal(isSlashCommand("/help"), true);
    });

    it("returns false for plain text", () => {
      assert.equal(isSlashCommand("hello"), false);
    });
  });

  describe("getSlashQuery", () => {
    it("returns query for autocomplete", () => {
      const result = getSlashQuery("/sta", 4);
      assert.equal(result.query, "sta");
    });

    it("returns null for non-slash", () => {
      assert.equal(getSlashQuery("hello", 5), null);
    });
  });

  describe("filterCommands", () => {
    it("returns all for empty query", () => {
      const results = filterCommands("");
      assert.ok(results.length > 0);
    });

    it("filters by prefix", () => {
      const results = filterCommands("sta");
      assert.ok(results.length > 0);
      assert.ok(results.some(c => c.name === "/status"));
    });

    it("filters by name", () => {
      const results = filterCommands("help");
      assert.ok(results.some(c => c.name === "/help"));
    });

    it("returns empty for no match", () => {
      const results = filterCommands("zzzzz");
      assert.equal(results.length, 0);
    });
  });

  describe("findCommand", () => {
    it("finds by name", () => {
      const cmd = findCommand("/status");
      assert.equal(cmd.name, "/status");
    });

    it("finds by alias", () => {
      const cmd = findCommand("/h");
      assert.equal(cmd.name, "/help");
    });

    it("finds without slash", () => {
      const cmd = findCommand("status");
      assert.equal(cmd.name, "/status");
    });

    it("returns undefined for unknown", () => {
      assert.equal(findCommand("/nonexistent"), undefined);
    });
  });

  describe("executeCommand", () => {
    it("executes known command", () => {
      const result = executeCommand("/status");
      assert.equal(result.success, true);
      assert.ok(result.message.includes("status"));
    });

    it("fails for unknown command", () => {
      const result = executeCommand("/nonexistent");
      assert.equal(result.success, false);
      assert.ok(result.message.includes("Unknown"));
    });

    it("uses custom handler", () => {
      const handlers = {
        "/status": () => ({ message: "Custom handler!" }),
      };
      const result = executeCommand("/status", { handlers });
      assert.equal(result.success, true);
      assert.equal(result.message, "Custom handler!");
    });

    it("returns error for non-slash", () => {
      const result = executeCommand("hello");
      assert.equal(result.success, false);
    });
  });

  describe("BUILT_IN_COMMANDS", () => {
    it("has required commands", () => {
      const names = BUILT_IN_COMMANDS.map(c => c.name);
      assert.ok(names.includes("/status"));
      assert.ok(names.includes("/help"));
      assert.ok(names.includes("/sessions"));
      assert.ok(names.includes("/send"));
    });

    it("all have descriptions", () => {
      for (const cmd of BUILT_IN_COMMANDS) {
        assert.ok(cmd.description.length > 0, `${cmd.name} missing description`);
        assert.ok(cmd.detail.length > 0, `${cmd.name} missing detail`);
      }
    });
  });
});
