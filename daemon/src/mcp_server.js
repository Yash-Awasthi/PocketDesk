/**
 * MCP Server — expose the harness's agents as MCP tools.
 *
 * Absorbed from quil / paseo / systemprompt-code-orchestrator (drive coding
 * agents programmatically): a JSON-RPC 2.0 endpoint speaking the MCP protocol
 * over the CLI's localhost HTTP server. Any MCP client on the PC (editor,
 * script, another agent) can list the discovered agent manifests and launch a
 * chat turn on any of them — the same code path the phone uses.
 *
 * Transport: streamable HTTP per MCP spec — POST /mcp with JSON-RPC body,
 * single JSON response (no SSE needed for stateless tool calls).
 */

import http from "node:http";
import * as registry from "./registry.js";
import * as chat from "./chat.js";

const PROTOCOL_VERSION = "2024-11-05";

let server = null;
let port = 0;
let sessionCounter = 0;
const sessions = new Map(); // mcpSessionId -> chatId

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolList() {
  const tools = [
    {
      name: "pocketdesk_agents",
      description: "List AI coding agents installed on this PC (Claude Code, Codex, ...) with chat support.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "pocketdesk_prompt",
      description: "Send a prompt to an agent on this PC and wait for the reply. Starts (or resumes) a chat session with that agent.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent manifest id, e.g. claude" },
          prompt: { type: "string", description: "The prompt text" },
          cwd: { type: "string", description: "Working directory on the PC" },
          session: { type: "string", description: "Optional session id from a previous call to continue that conversation" },
        },
        required: ["agent", "prompt"],
      },
    },
  ];
  return tools;
}

async function callTool(name, args) {
  if (name === "pocketdesk_agents") {
    const items = registry.list().map((r) => ({
      id: r.manifest.id,
      name: r.manifest.name,
      installed: Boolean(r.installed),
      chat: Boolean(r.manifest?.chat?.args),
    }));
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
  if (name === "pocketdesk_prompt") {
    const agentId = String(args?.agent ?? "");
    const m = registry.get(agentId);
    if (!m) throw new Error(`unknown agent: ${agentId}`);
    if (!chat.supported(m)) throw new Error(`${m.name} has no chat adapter`);
    const prompt = String(args?.prompt ?? "");
    if (!prompt.trim()) throw new Error("empty prompt");

    let chatId = args?.session ? sessions.get(String(args.session)) : undefined;
    if (chatId && !chat.get(chatId)) chatId = undefined;

    let sessionId = args?.session ? String(args.session) : undefined;
    if (!chatId) {
      const created = chat.create({ manifest: m, cwd: args?.cwd });
      chatId = created.id;
      if (!sessionId) {
        sessionId = "mcp_" + (++sessionCounter);
      }
      sessions.set(sessionId, chatId);
    }

    const reply = await new Promise((resolve, reject) => {
      const c = chat.get(chatId);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("agent timed out after 120s"));
      }, 120_000);
      function cleanup() {
        clearTimeout(timer);
        chat.detach(null, chatId); // no-op-safe: detach by ws only
      }
      const sink = {
        _subs: new Set(),
        readyState: 1,
        send(raw) {
          try {
            const msg = JSON.parse(raw);
            if (msg.type === "chatdelta" && msg.id === chatId) sink._text += msg.text;
            else if (msg.type === "chatstate" && msg.id === chatId && (msg.state === "idle" || msg.state === "error")) {
              cleanup();
              resolve({ text: sink._text.trim(), state: msg.state });
            }
          } catch {}
        },
        _text: "",
      };
      c.subs.add(sink);
      chat.sendUserMessage(c, prompt);
    });
    return { content: [{ type: "text", text: reply.text }], meta: { session: sessionId, state: reply.state } };
  }
  throw new Error(`unknown tool: ${name}`);
}

async function handleRpc(body) {
  const { id, method, params } = body ?? {};
  switch (method) {
    case "initialize":
      return jsonRpc(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "pocketdesk", version: "0.2.0" } });
    case "notifications/initialized":
      return null; // notification — no response body
    case "ping":
      return jsonRpc(id, {});
    case "tools/list":
      return jsonRpc(id, { tools: toolList() });
    case "tools/call": {
      try {
        const result = await callTool(params?.name, params?.arguments ?? {});
        return jsonRpc(id, result);
      } catch (e) {
        return jsonRpcError(id, -32000, e.message);
      }
    }
    default:
      return jsonRpcError(id, -32601, `method not found: ${method}`);
  }
}

export function start(listenPort = 4680) {
  if (server) return port;
  port = Number(listenPort) || 4680;
  server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/mcp")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "POST /mcp only" }));
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(jsonRpcError(null, -32700, "parse error")));
        return;
      }
      const reply = await handleRpc(body);
      if (reply === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  server.on("error", (err) => {
    console.warn(`  mcp       unavailable: ${err.message}`);
    server = null;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`  mcp       http://127.0.0.1:${port}/mcp`);
  });
  return port;
}

export function stop() {
  if (server) server.close();
  server = null;
  port = 0;
}

export function status() {
  return { running: Boolean(server), port, sessions: sessions.size };
}
