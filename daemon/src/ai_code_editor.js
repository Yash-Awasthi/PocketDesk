/**
 * AI Code Editor — multi-format code editing patterns.
 * Extracted from aider — edit formats, fence detection, code block handling.
 */

const ALL_FENCES = [
  ["```", "```"],
  ["````", "````"],
  ["<source>", "</source>"],
  ["<code>", "</code>"],
  ["<pre>", "</pre>"],
  ["<codeblock>", "</codeblock>"],
  ["<sourcecode>", "</sourcecode>"],
];

function wrapFence(name) {
  return [`<${name}>`, `</${name}>`];
}

function removeFences(content) {
  let result = content;
  for (const [open, close] of ALL_FENCES) {
    if (result.startsWith(open)) {
      result = result.slice(open.length);
    }
    if (result.endsWith(close)) {
      result = result.slice(0, -close.length);
    }
  }
  return result.trim();
}

function wrapInFence(code, fence = "```") {
  return `${fence}\n${code}\n${fence}`;
}

function extractCodeBlocks(text) {
  const blocks = [];
  for (const [open, close] of ALL_FENCES) {
    let start = 0;
    while (true) {
      const openIdx = text.indexOf(open, start);
      if (openIdx === -1) break;
      const closeIdx = text.indexOf(close, openIdx + open.length);
      if (closeIdx === -1) break;
      blocks.push(text.slice(openIdx + open.length, closeIdx).trim());
      start = closeIdx + close.length;
    }
  }
  return blocks;
}

function detectLanguage(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map = {
    js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", h: "c",
    html: "html", css: "css", scss: "scss", json: "json",
    yaml: "yaml", yml: "yaml", md: "markdown", sh: "bash",
    bash: "bash", zsh: "bash", ps1: "powershell",
  };
  return map[ext] || "text";
}

function formatEditBlock(filename, oldCode, newCode) {
  const lang = detectLanguage(filename);
  return `<${filename}\n<<<<<<< SEARCH\n\`\`\`${lang}\n${oldCode}\n\`\`\`\n=======\n\`\`\`${lang}\n${newCode}\n\`\`\`\n>>>>>>> REPLACE`;
}

function parseEditBlock(block) {
  const filenameMatch = block.match(/^(.+?)\n/);
  const filename = filenameMatch?.[1] || "";
  const searchMatch = block.match(/<<<<<<< SEARCH\n([\s\S]*?)=======/);
  const replaceMatch = block.match(/=======\n([\s\S]*?)>>>>>>> REPLACE/);
  const oldCode = searchMatch ? removeFences(searchMatch[1].trim()) : "";
  const newCode = replaceMatch ? removeFences(replaceMatch[1].trim()) : "";
  return { filename, oldCode, newCode };
}

function applyEdit(original, oldCode, newCode) {
  if (!oldCode) return { applied: false, reason: "Empty search block" };
  const idx = original.indexOf(oldCode);
  if (idx === -1) {
    const normalized = oldCode.replace(/\s+/g, " ").trim();
    const origNorm = original.replace(/\s+/g, " ");
    const normIdx = origNorm.indexOf(normalized);
    if (normIdx === -1) {
      return { applied: false, reason: "Search block not found" };
    }
    const result = original.slice(0, normIdx) + newCode + original.slice(normIdx + normalized.length);
    return { applied: true, result };
  }
  const result = original.slice(0, idx) + newCode + original.slice(idx + oldCode.length);
  return { applied: true, result };
}

function hashContent(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(16);
}

class ChatChunks {
  constructor() {
    this.system = [];
    this.user = [];
    this.assistant = [];
    this.toolResults = [];
  }

  addMessage(role, content, options = {}) {
    const msg = { role, content, ...options };
    switch (role) {
      case "system": this.system.push(msg); break;
      case "user": this.user.push(msg); break;
      case "assistant": this.assistant.push(msg); break;
      default: this.toolResults.push(msg);
    }
  }

  toMessages() {
    return [...this.system, ...this.user, ...this.assistant, ...this.toolResults];
  }

  getCurMessages() {
    return this.toMessages();
  }

  formatMessages() {
    return this.toMessages().map(
      (m) => `[${m.role}]: ${typeof m.content === "string" ? m.content.slice(0, 200) : "[complex]"}`
    );
  }
}

module.exports = {
  ALL_FENCES,
  wrapFence,
  removeFences,
  wrapInFence,
  extractCodeBlocks,
  detectLanguage,
  formatEditBlock,
  parseEditBlock,
  applyEdit,
  hashContent,
  ChatChunks,
};
