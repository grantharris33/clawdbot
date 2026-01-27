/**
 * Tests for the Claude Code stream parser.
 */

import { describe, expect, it } from "vitest";
import {
  StreamParser,
  extractMessageType,
  formatForClient,
  extractUsage,
  extractSessionId,
  isCompletionMessage,
  isErrorMessage,
} from "./stream-parser.js";
import type { StreamMessage } from "./types.js";

describe("StreamParser", () => {
  it("should parse a single complete JSON object", () => {
    const parser = new StreamParser();
    const messages = parser.feed(
      '{"type":"assistant","message":{"type":"text","content":"Hello"}}',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: "assistant",
      message: { type: "text", content: "Hello" },
    });
  });

  it("should parse multiple JSON objects in one chunk", () => {
    const parser = new StreamParser();
    const messages = parser.feed(
      '{"type":"assistant","message":{}}{"type":"tool_use","tool":"read"}',
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "assistant" });
    expect(messages[1]).toMatchObject({ type: "tool_use", tool: "read" });
  });

  it("should handle incremental data across multiple chunks", () => {
    const parser = new StreamParser();

    // Feed partial JSON
    let messages = parser.feed('{"type":"assis');
    expect(messages).toHaveLength(0);

    // Feed more partial data
    messages = parser.feed('tant","message"');
    expect(messages).toHaveLength(0);

    // Complete the JSON
    messages = parser.feed(":{}}");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "assistant", message: {} });
  });

  it("should handle garbage before JSON", () => {
    const parser = new StreamParser();
    const messages = parser.feed('some text before {"type":"test"}');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "test" });
  });

  it("should handle nested braces", () => {
    const parser = new StreamParser();
    const messages = parser.feed('{"type":"tool_use","input":{"nested":{"deep":true}}}');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: "tool_use",
      input: { nested: { deep: true } },
    });
  });

  it("should reset state correctly", () => {
    const parser = new StreamParser();

    // Feed partial data
    parser.feed('{"type":"partial');
    expect(parser.hasPending()).toBe(true);

    // Reset
    parser.reset();
    expect(parser.hasPending()).toBe(false);

    // Feed new data
    const messages = parser.feed('{"type":"new"}');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "new" });
  });

  it("should skip invalid JSON", () => {
    const parser = new StreamParser();
    const messages = parser.feed('{invalid json}{"type":"valid"}');

    // Should skip invalid and find valid
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "valid" });
  });
});

describe("extractMessageType", () => {
  it("should extract type from top-level", () => {
    expect(extractMessageType({ type: "assistant" })).toBe("assistant");
    expect(extractMessageType({ type: "tool_use" })).toBe("tool_use");
    expect(extractMessageType({ type: "result" })).toBe("result");
  });

  it("should handle nested message structure", () => {
    expect(extractMessageType({ type: "message", message: { type: "text" } })).toBe("text");
  });

  it("should return unknown for missing type", () => {
    expect(extractMessageType({})).toBe("unknown");
  });
});

describe("formatForClient", () => {
  it("should format assistant message", () => {
    const msg: StreamMessage = {
      type: "assistant",
      message: { type: "text", content: "Hello" },
    };
    const formatted = formatForClient(msg);

    expect(formatted.type).toBe("assistant");
    expect(formatted.message).toEqual({ type: "text", content: "Hello" });
  });

  it("should format tool_use message", () => {
    const msg: StreamMessage = {
      type: "tool_use",
      tool: "read",
      input: { path: "/test" },
    };
    const formatted = formatForClient(msg);

    expect(formatted.type).toBe("tool_use");
    expect(formatted.tool).toBe("read");
    expect(formatted.input).toEqual({ path: "/test" });
  });

  it("should format result message with usage", () => {
    const msg: StreamMessage = {
      type: "result",
      subtype: "success",
      result: "Done",
      usage: { input_tokens: 100, output_tokens: 50 },
      duration_ms: 1500,
      session_id: "sess-123",
    };
    const formatted = formatForClient(msg);

    expect(formatted.type).toBe("result");
    expect(formatted.data).toMatchObject({
      subtype: "success",
      result: "Done",
      usage: { input_tokens: 100, output_tokens: 50 },
      duration_ms: 1500,
      session_id: "sess-123",
    });
  });

  it("should handle camelCase usage fields", () => {
    const msg: StreamMessage = {
      type: "result",
      usage: { inputTokens: 100, outputTokens: 50 },
    } as unknown as StreamMessage;
    const formatted = formatForClient(msg);

    expect((formatted.data as { usage: { input_tokens: number } }).usage.input_tokens).toBe(100);
  });
});

describe("extractUsage", () => {
  it("should extract usage from result message", () => {
    const msg: StreamMessage = {
      type: "result",
      usage: { input_tokens: 100, output_tokens: 50 },
    } as StreamMessage;

    const usage = extractUsage(msg);
    expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it("should return zeros for non-result message", () => {
    const msg: StreamMessage = { type: "assistant", message: { type: "text" } };
    const usage = extractUsage(msg);
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("extractSessionId", () => {
  it("should extract session_id from result message", () => {
    const msg: StreamMessage = {
      type: "result",
      session_id: "sess-abc-123",
    } as StreamMessage;

    expect(extractSessionId(msg)).toBe("sess-abc-123");
  });

  it("should return undefined for non-result message", () => {
    const msg: StreamMessage = { type: "assistant", message: { type: "text" } };
    expect(extractSessionId(msg)).toBeUndefined();
  });
});

describe("isCompletionMessage", () => {
  it("should return true for result type", () => {
    expect(isCompletionMessage({ type: "result" } as StreamMessage)).toBe(true);
  });

  it("should return false for other types", () => {
    expect(isCompletionMessage({ type: "assistant" } as StreamMessage)).toBe(false);
    expect(isCompletionMessage({ type: "tool_use" } as StreamMessage)).toBe(false);
  });
});

describe("isErrorMessage", () => {
  it("should return true for error type", () => {
    expect(isErrorMessage({ type: "error", error: "fail" } as StreamMessage)).toBe(true);
  });

  it("should return true for result with error subtype", () => {
    expect(isErrorMessage({ type: "result", subtype: "error" } as StreamMessage)).toBe(true);
  });

  it("should return false for success result", () => {
    expect(isErrorMessage({ type: "result", subtype: "success" } as StreamMessage)).toBe(false);
  });
});
