/**
 * Stream JSON Parser — Parse and format AI agent streaming JSON output.
 *
 * Inspired by claude-stream-json-parser (Rust).
 * Processes JSON Lines output from AI agents, converting each message
 * into structured, human-readable format.
 */

// ============================================================================
// Types
// ============================================================================

export type MessageType =
  | 'system_init'
  | 'system_error'
  | 'assistant_text'
  | 'assistant_tool_use'
  | 'assistant_tool_result'
  | 'user_message'
  | 'metadata'
  | 'unknown';

export interface ParsedMessage {
  type: MessageType;
  raw: Record<string, unknown>;
  formatted: string;
  timestamp: Date;
  sessionId?: string;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    id: string;
    role: string;
    model?: string;
    content?: Array<{ type: string; text?: string; tool_use?: ToolUse; tool_result?: ToolResult }>;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  session_id?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: string[];
  model?: string;
  parent_tool_use_id?: string;
}

// ============================================================================
// Stream Parser
// ============================================================================

export class StreamJsonParser {
  private sessionTools: Map<string, ToolUse> = new Map();
  private messageCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  /**
   * Parse a single JSON line from AI agent output.
   */
  parseLine(line: string): ParsedMessage | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const msg = JSON.parse(trimmed) as StreamEvent;
      return this.formatMessage(msg);
    } catch {
      return null;
    }
  }

  /**
   * Parse multiple lines at once.
   */
  parseLines(lines: string): ParsedMessage[] {
    return lines
      .split('\n')
      .map((line) => this.parseLine(line))
      .filter((msg): msg is ParsedMessage => msg !== null);
  }

  /**
   * Format a stream event into a structured message.
   */
  private formatMessage(event: StreamEvent): ParsedMessage {
    const base = {
      raw: event as unknown as Record<string, unknown>,
      timestamp: new Date(),
      sessionId: event.session_id,
    };

    switch (event.type) {
      case 'system':
        return this.formatSystemMessage(event, base);
      case 'assistant':
        return this.formatAssistantMessage(event, base);
      case 'user':
        return this.formatUserMessage(event, base);
      case 'metadata':
        return { ...base, type: 'metadata', formatted: this.formatMetadata(event) };
      default:
        return { ...base, type: 'unknown', formatted: JSON.stringify(event) };
    }
  }

  private formatSystemMessage(event: StreamEvent, base: Omit<ParsedMessage, 'type' | 'formatted'>): ParsedMessage {
    if (event.subtype === 'init') {
      const tools = event.tools?.length ? event.tools.join(', ') : 'none';
      const mcp = event.mcp_servers?.length ? event.mcp_servers.join(', ') : 'none';
      return {
        ...base,
        type: 'system_init',
        formatted: `[SYSTEM] Session started | model: ${event.model || 'unknown'} | cwd: ${event.cwd || '/'} | tools: ${tools} | mcp: ${mcp}`,
      };
    }
    return {
      ...base,
      type: 'system_error',
      formatted: `[SYSTEM:${event.subtype || 'event'}] ${JSON.stringify(event.message || event)}`,
    };
  }

  private formatAssistantMessage(event: StreamEvent, base: Omit<ParsedMessage, 'type' | 'formatted'>): ParsedMessage {
    const msg = event.message;
    if (!msg) {
      return { ...base, type: 'assistant_text', formatted: '[ASSISTANT] (empty)' };
    }

    this.messageCount++;
    if (msg.usage) {
      this.totalInputTokens += msg.usage.input_tokens;
      this.totalOutputTokens += msg.usage.output_tokens;
    }

    const parts: string[] = [];
    let hasToolUse = false;

    for (const block of msg.content || []) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'tool_use' && block.tool_use) {
        hasToolUse = true;
        this.sessionTools.set(block.tool_use.id, block.tool_use);
        const inputStr = JSON.stringify(block.tool_use.input).slice(0, 200);
        parts.push(`[TOOL: ${block.tool_use.name}] ${inputStr}${inputStr.length >= 200 ? '...' : ''}`);
      } else if (block.type === 'tool_result' && block.tool_result) {
        const result = block.tool_result;
        const contentPreview = result.content.slice(0, 200);
        parts.push(`[RESULT: ${result.toolUseId}] ${result.isError ? 'ERROR: ' : ''}${contentPreview}${result.content.length >= 200 ? '...' : ''}`);
        this.sessionTools.delete(result.toolUseId);
      }
    }

    const formatted = parts.join('\n') || '[ASSISTANT] (no content)';

    if (hasToolUse) {
      return { ...base, type: 'assistant_tool_use', formatted };
    }

    return { ...base, type: 'assistant_text', formatted };
  }

  private formatUserMessage(event: StreamEvent, base: Omit<ParsedMessage, 'type' | 'formatted'>): ParsedMessage {
    const msg = event.message;
    const text = msg?.content?.map((b) => b.text || '').join('') || '';
    return { ...base, type: 'user_message', formatted: `[USER] ${text}` };
  }

  private formatMetadata(event: StreamEvent): string {
    const parts: string[] = [];
    if (event.type) parts.push(`type: ${event.type}`);
    if (event.subtype) parts.push(`subtype: ${event.subtype}`);
    if (event.session_id) parts.push(`session: ${event.session_id}`);
    return `[METADATA] ${parts.join(', ')}`;
  }

  /**
   * Get session statistics.
   */
  getStats(): {
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    pendingTools: number;
  } {
    return {
      messageCount: this.messageCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      pendingTools: this.sessionTools.size,
    };
  }

  /**
   * Get all pending tool uses.
   */
  getPendingTools(): ToolUse[] {
    return Array.from(this.sessionTools.values());
  }

  /**
   * Reset session state.
   */
  reset(): void {
    this.sessionTools.clear();
    this.messageCount = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
}
