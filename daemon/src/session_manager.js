/**
 * Session Manager
 *
 * Extracted from 247-claude-code-remote (inspiration).
 * Manages tmux session lifecycle: creation, attachment, persistence,
 * shell detection, and init script generation.
 */

import { exec, execSync } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

/**
 * @typedef {Object} SessionInfo
 * @property {string} name
 * @property {string} cwd
 * @property {string} status - 'running', 'stopped', 'unknown'
 * @property {string} shell
 * @property {number} created_at
 * @property {string} project
 */

/**
 * Detect the user's preferred shell
 * @returns {string} Shell path
 */
export function detectUserShell() {
  const shell = process.env.SHELL || process.env.COMSPEC || "/bin/sh";
  return shell;
}

/**
 * Generate init script for new tmux sessions
 * @param {Object} options
 * @returns {string} Init script content
 */
export function generateInitScript({
  sessionName = "pocketdesk",
  projectName = "project",
  customEnvVars = {},
  shell = "bash",
  targetShell = null,
} = {}) {
  const lines = [
    "#!/bin/bash",
    "# Auto-generated init script for PocketDesk session",
    `# Session: ${sessionName}`,
    `# Project: ${projectName}`,
    "",
    "# Set custom environment variables",
  ];

  for (const [key, value] of Object.entries(customEnvVars)) {
    lines.push(`export ${key}="${value}"`);
  }

  lines.push("");
  lines.push("# Set session metadata");
  lines.push(`export POCKETDESK_SESSION="${sessionName}"`);
  lines.push(`export POCKETDESK_PROJECT="${projectName}"`);
  lines.push("");

  if (targetShell && targetShell !== shell) {
    lines.push(`# Switch to user's preferred shell`);
    lines.push(`exec ${targetShell} -i`);
  }

  return lines.join("\n");
}

/**
 * Check if a tmux session exists
 * @param {string} sessionName
 * @returns {boolean}
 */
export function sessionExists(sessionName) {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all tmux sessions
 * @returns {string[]} Session names
 */
export function listSessions() {
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
      encoding: "utf-8",
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get session info
 * @param {string} sessionName
 * @returns {SessionInfo | null}
 */
export function getSessionInfo(sessionName) {
  if (!sessionExists(sessionName)) {
    return null;
  }

  try {
    const output = execSync(
      `tmux display-message -t "${sessionName}" -p '#{session_name} #{session_path} #{session_created}'`,
      { encoding: "utf-8" }
    );
    const [name, cwd, createdAt] = output.trim().split(" ");

    return {
      name,
      cwd: cwd || process.cwd(),
      status: "running",
      shell: detectUserShell(),
      created_at: parseInt(createdAt) * 1000 || Date.now(),
      project: path.basename(cwd || process.cwd()),
    };
  } catch {
    return null;
  }
}

/**
 * Create a new tmux session
 * @param {string} sessionName
 * @param {string} cwd - Working directory
 * @param {Object} options - Additional options
 * @returns {{ success: boolean, message: string }}
 */
export function createSession(sessionName, cwd = process.cwd(), options = {}) {
  if (sessionExists(sessionName)) {
    return { success: false, message: `Session '${sessionName}' already exists` };
  }

  const { customEnvVars = {} } = options;
  const scriptContent = generateInitScript({
    sessionName,
    projectName: path.basename(cwd),
    customEnvVars,
  });

  const initScriptPath = path.join(os.tmpdir(), `rh-init-${sessionName}.sh`);
  const fs = await import("fs");
  fs.writeFileSync(initScriptPath, scriptContent, { mode: 0o755 });

  try {
    execSync(
      `tmux new-session -d -s "${sessionName}" -c "${cwd}" "bash --init-file ${initScriptPath}"`,
      { encoding: "utf-8" }
    );
    return { success: true, message: `Session '${sessionName}' created` };
  } catch (err) {
    return { success: false, message: `Failed to create session: ${err.message}` };
  }
}

/**
 * Kill a tmux session
 * @param {string} sessionName
 * @returns {{ success: boolean, message: string }}
 */
export function killSession(sessionName) {
  if (!sessionExists(sessionName)) {
    return { success: false, message: `Session '${sessionName}' not found` };
  }

  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { encoding: "utf-8" });
    return { success: true, message: `Session '${sessionName}' killed` };
  } catch (err) {
    return { success: false, message: `Failed to kill session: ${err.message}` };
  }
}

/**
 * Capture terminal output from a session
 * @param {string} sessionName
 * @param {number} lines - Number of lines to capture
 * @returns {string}
 */
export function captureOutput(sessionName, lines = 100) {
  if (!sessionExists(sessionName)) {
    return "";
  }

  try {
    return execSync(
      `tmux capture-pane -t "${sessionName}" -p -S -${lines}`,
      { encoding: "utf-8" }
    );
  } catch {
    return "";
  }
}

/**
 * Send keys to a tmux session
 * @param {string} sessionName
 * @param {string} keys
 * @returns {{ success: boolean }}
 */
export function sendKeys(sessionName, keys) {
  if (!sessionExists(sessionName)) {
    return { success: false };
  }

  try {
    execSync(`tmux send-keys -t "${sessionName}" '${keys}' Enter`, {
      encoding: "utf-8",
    });
    return { success: true };
  } catch {
    return { success: false };
  }
}

/**
 * Get session status from output
 * @param {string} output - Terminal output
 * @returns {'working' | 'waiting' | 'idle' | 'completed'}
 */
export function detectSessionStatus(output) {
  if (!output || !output.trim()) return "idle";

  const lower = output.toLowerCase();

  // Working indicators
  if (/working|thinking|running.*interrupt/i.test(lower) ||
      /press\s+(?:esc|ctrl-c)\s+to\s+interrupt/i.test(lower)) {
    return "working";
  }

  // Waiting indicators
  if (/press enter to confirm/i.test(lower) ||
      /do you want|should i|please choose/i.test(lower)) {
    return "waiting";
  }

  // Completion indicators
  if (/task complete|goal achieved|done|completed/i.test(lower)) {
    return "completed";
  }

  return "idle";
}
