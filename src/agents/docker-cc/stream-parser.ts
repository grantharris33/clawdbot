/**
 * Parser for Claude Code JSON streaming output.
 *
 * This module handles parsing the stream-json output format from Claude Code CLI,
 * which outputs JSON objects in a continuous stream. The parser handles incremental
 * data and extracts complete JSON objects as they arrive.
 *
 * Ported from CC-Docker Python wrapper (stream_parser.py).
 */

import type { FormattedMessage, StreamMessage, StreamMessageType } from "./types.js";

/**
 * Incremental parser for Claude Code's stream-json output.
 */
export class StreamParser {
  private buffer = "";
  private inJson = false;
  private braceCount = 0;
  private scanPosition = 0;

  /**
   * Feed data to the parser and return any complete JSON objects.
   *
   * @param data - Raw output data from Claude Code
   * @returns List of parsed JSON objects
   */
  feed(data: string): StreamMessage[] {
    const results: StreamMessage[] = [];
    this.buffer += data;

    while (this.buffer.length > 0) {
      if (!this.inJson) {
        // Look for start of JSON object
        const idx = this.buffer.indexOf("{");
        if (idx === -1) {
          this.buffer = "";
          this.scanPosition = 0;
          break;
        }
        this.buffer = this.buffer.slice(idx);
        this.inJson = true;
        this.braceCount = 0;
        this.scanPosition = 0;
      }

      // Count braces to find complete JSON, starting from where we left off
      let foundComplete = false;
      for (let i = this.scanPosition; i < this.buffer.length; i++) {
        const char = this.buffer[i];
        if (char === "{") {
          this.braceCount++;
        } else if (char === "}") {
          this.braceCount--;

          if (this.braceCount === 0) {
            // Found complete JSON object
            const jsonStr = this.buffer.slice(0, i + 1);
            this.buffer = this.buffer.slice(i + 1);
            this.inJson = false;
            this.scanPosition = 0;
            foundComplete = true;

            try {
              const obj = JSON.parse(jsonStr) as StreamMessage;
              results.push(obj);
            } catch {
              // Failed to parse JSON, skip it
            }
            break;
          }
        }
      }

      if (!foundComplete) {
        // Incomplete JSON, remember where we stopped
        this.scanPosition = this.buffer.length;
        break;
      }
    }

    return results;
  }

  /**
   * Reset parser state.
   */
  reset(): void {
    this.buffer = "";
    this.inJson = false;
    this.braceCount = 0;
    this.scanPosition = 0;
  }

  /**
   * Check if parser has pending incomplete data.
   */
  hasPending(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * Get any remaining buffer content (for debugging).
   */
  getPendingBuffer(): string {
    return this.buffer;
  }
}

/**
 * Extract the type of a Claude Code message.
 *
 * Claude Code stream-json format includes various message types:
 * - assistant: Text output from Claude
 * - tool_use: Tool invocation
 * - tool_result: Result of tool execution
 * - result: Final result with cost/usage info
 * - system: System messages
 */
export function extractMessageType(message: Record<string, unknown>): StreamMessageType {
  const msgType = message.type as string | undefined;

  // Handle nested message structure
  if (msgType === "message") {
    const inner = message.message as Record<string, unknown> | undefined;
    return (inner?.type as StreamMessageType) ?? "unknown";
  }

  return (msgType as StreamMessageType) ?? "unknown";
}

/**
 * Format a Claude Code message for client consumption.
 *
 * Normalizes the message structure for consistent client handling.
 */
export function formatForClient(message: StreamMessage): FormattedMessage {
  const msgType = extractMessageType(message as unknown as Record<string, unknown>);

  switch (msgType) {
    case "assistant": {
      const m = message as { message?: unknown };
      return {
        type: "assistant",
        message: m.message,
      };
    }

    case "tool_use": {
      const m = message as { tool?: string; name?: string; input?: unknown };
      return {
        type: "tool_use",
        tool: m.tool ?? m.name,
        input: m.input,
      };
    }

    case "tool_result": {
      const m = message as {
        tool?: string;
        name?: string;
        result?: unknown;
        output?: string;
      };
      return {
        type: "tool_result",
        tool: m.tool ?? m.name,
        result: m.result ?? m.output,
      };
    }

    case "system": {
      const m = message as { subtype?: string; event?: string; data?: unknown };
      return {
        type: "system",
        event: m.subtype ?? m.event ?? "system",
        data: m.data ?? message,
      };
    }

    case "result": {
      const m = message as {
        subtype?: string;
        result?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          inputTokens?: number;
          outputTokens?: number;
        };
        duration_ms?: number;
        session_id?: string;
      };
      const usage = m.usage ?? {};
      return {
        type: "result",
        data: {
          subtype: m.subtype ?? "success",
          result: m.result,
          usage: {
            input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
            output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
          },
          duration_ms: m.duration_ms,
          session_id: m.session_id,
        },
      };
    }

    default:
      // Pass through other message types with type info
      return {
        type: msgType,
        data: message,
      };
  }
}

/**
 * Extract usage info from a result message.
 */
export function extractUsage(message: StreamMessage): {
  input_tokens: number;
  output_tokens: number;
} {
  if (message.type !== "result") {
    return { input_tokens: 0, output_tokens: 0 };
  }

  const m = message as {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
  };

  const usage = m.usage ?? {};
  return {
    input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
  };
}

/**
 * Extract Claude session ID from a result message.
 */
export function extractSessionId(message: StreamMessage): string | undefined {
  if (message.type !== "result") {
    return undefined;
  }

  const m = message as { session_id?: string };
  return m.session_id;
}

/**
 * Check if a message indicates completion.
 */
export function isCompletionMessage(message: StreamMessage): boolean {
  return message.type === "result";
}

/**
 * Check if a message indicates an error.
 */
export function isErrorMessage(message: StreamMessage): boolean {
  if (message.type === "error") {
    return true;
  }
  if (message.type === "result") {
    const m = message as { subtype?: string };
    return m.subtype === "error";
  }
  return false;
}

/**
 * Parse a line-delimited stream of JSON objects (JSONL format).
 */
export function* parseJsonl(data: string): Generator<StreamMessage> {
  const lines = data.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const obj = JSON.parse(trimmed) as StreamMessage;
      yield obj;
    } catch {
      // Skip invalid JSON lines
    }
  }
}

/**
 * Create an async iterator that parses streaming data.
 */
export async function* parseStream(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<StreamMessage> {
  const parser = new StreamParser();

  for await (const chunk of stream) {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const messages = parser.feed(data);
    for (const msg of messages) {
      yield msg;
    }
  }

  // Note: We don't yield incomplete data at the end
  // If there's pending data, it means the stream was cut off mid-JSON
}
