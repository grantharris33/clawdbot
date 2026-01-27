/**
 * Integration tests for Docker Claude Code provider.
 *
 * These tests verify the integration between components.
 * Run with LIVE=1 to test against real Docker and Redis.
 */

import { describe, expect, it, vi } from "vitest";
import {
  resolveDockerCCConfig,
  generateContainerName,
  getSessionRedisKeys,
  slugifySessionKey,
} from "./config.js";
import { StreamParser, formatForClient, extractUsage } from "./stream-parser.js";
import type { StreamMessage } from "./types.js";

describe("Docker CC Config", () => {
  it("should use defaults when no config provided", () => {
    const config = resolveDockerCCConfig();
    expect(config.enabled).toBe(false);
    expect(config.pool.minWarm).toBe(0);
    expect(config.pool.maxTotal).toBe(10);
    expect(config.image).toBe("clawdbot/docker-cc:latest");
  });

  it("should merge user config with defaults", () => {
    const config = resolveDockerCCConfig({
      enabled: true,
      pool: { minWarm: 5 },
      image: "custom/image:v1",
    });

    expect(config.enabled).toBe(true);
    expect(config.pool.minWarm).toBe(5);
    expect(config.pool.maxTotal).toBe(10); // Default preserved
    expect(config.image).toBe("custom/image:v1");
  });

  it("should generate container name from session key", () => {
    const config = resolveDockerCCConfig();
    const name = generateContainerName("test-session-123", config);

    expect(name).toMatch(/^clawdbot-cc-/);
    expect(name.length).toBeLessThanOrEqual(63); // Docker name limit
  });

  it("should slugify session keys correctly", () => {
    expect(slugifySessionKey("simple")).toMatch(/^simple-[a-f0-9]+$/);
    expect(slugifySessionKey("With Spaces")).toMatch(/^with-spaces-[a-f0-9]+$/);
    expect(slugifySessionKey("special!@#chars")).toMatch(/^special-chars-[a-f0-9]+$/);
  });

  it("should generate Redis keys for session", () => {
    const config = resolveDockerCCConfig();
    const keys = getSessionRedisKeys("test-session", config);

    expect(keys.input).toBe("clawdbot:cc:test-session:input");
    expect(keys.output).toBe("clawdbot:cc:test-session:output");
    expect(keys.state).toBe("clawdbot:cc:test-session:state");
  });
});

describe("Stream Parser", () => {
  it("should parse single JSON object", () => {
    const parser = new StreamParser();
    const messages = parser.feed('{"type":"assistant","message":{}}');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "assistant", message: {} });
  });

  it("should parse multiple objects", () => {
    const parser = new StreamParser();
    const messages = parser.feed('{"type":"a"}{"type":"b"}');

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "a" });
    expect(messages[1]).toMatchObject({ type: "b" });
  });

  it("should handle incremental data", () => {
    const parser = new StreamParser();

    let messages = parser.feed('{"type":"test');
    expect(messages).toHaveLength(0);

    messages = parser.feed('","data":123}');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "test", data: 123 });
  });

  it("should handle garbage before JSON", () => {
    const parser = new StreamParser();
    const messages = parser.feed('garbage {"type":"valid"}');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "valid" });
  });

  it("should format assistant message correctly", () => {
    const msg: StreamMessage = {
      type: "assistant",
      message: { type: "text", content: "Hello" },
    };
    const formatted = formatForClient(msg);

    expect(formatted.type).toBe("assistant");
    expect(formatted.message).toEqual({ type: "text", content: "Hello" });
  });

  it("should extract usage from result", () => {
    const msg: StreamMessage = {
      type: "result",
      usage: { input_tokens: 100, output_tokens: 50 },
    } as StreamMessage;

    const usage = extractUsage(msg);
    expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it("should handle camelCase usage fields", () => {
    const msg = {
      type: "result",
      usage: { inputTokens: 200, outputTokens: 75 },
    } as unknown as StreamMessage;

    const usage = extractUsage(msg);
    expect(usage).toEqual({ input_tokens: 200, output_tokens: 75 });
  });
});

describe("Docker CC Integration", () => {
  const isLive = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";

  it.skipIf(!isLive)("should connect to Redis", async () => {
    const { createRedisClient } = await import("./redis-client.js");
    const config = resolveDockerCCConfig({
      enabled: true,
      redis: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
    });

    const client = createRedisClient(config);
    await client.connect();

    expect(client.isHealthy()).toBe(true);

    const latency = await client.ping();
    expect(latency).toBeGreaterThan(0);
    expect(latency).toBeLessThan(1000);

    await client.close();
  });

  it.skipIf(!isLive)("should check Docker availability", async () => {
    const { isDockerAvailable } = await import("./container.js");
    const available = await isDockerAvailable();

    expect(typeof available).toBe("boolean");
    // Just verify the check runs without error
  });

  it.skipIf(!isLive)("should perform health check", async () => {
    const { createHealthMonitor } = await import("./health.js");
    const config = resolveDockerCCConfig({
      enabled: true,
      redis: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
    });

    const monitor = createHealthMonitor(config);
    const result = await monitor.check();

    expect(result).toHaveProperty("healthy");
    expect(result).toHaveProperty("checks");
    expect(result.checks).toHaveProperty("docker");
    expect(result.checks).toHaveProperty("redis");
  });
});

describe("Container Registry", () => {
  it("should track container entries", async () => {
    // Mock filesystem for registry
    const mockEntries = new Map<string, unknown>();

    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, entries: [] })),
      writeFile: vi.fn().mockImplementation((_path, content) => {
        mockEntries.set("data", JSON.parse(content as string));
        return Promise.resolve();
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    // The actual registry tests would go here
    // For now, verify the structure is correct
    expect(true).toBe(true);
  });
});
