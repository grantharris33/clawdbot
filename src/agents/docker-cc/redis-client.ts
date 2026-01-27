/**
 * Redis client for Docker CC communication.
 *
 * This module handles the host-side Redis communication with Docker CC containers.
 * It manages pub/sub subscriptions, queue operations, and state tracking.
 */

import { Redis } from "ioredis";
import type {
  ContainerHealthStatus,
  DockerCCPoolConfig,
  FormattedMessage,
  InputMessage,
  InterruptMessage,
  OutputPayload,
  ResultData,
  SessionRedisKeys,
} from "./types.js";
import { getSessionRedisKeys, resolveRedisUrl } from "./config.js";

/**
 * Maximum number of output messages to buffer.
 */
const MAX_OUTPUT_BUFFER = 1000;

/**
 * Default expiry for session data (1 hour).
 */
const SESSION_DATA_EXPIRY_SEC = 3600;

/**
 * Redis client manager for Docker CC sessions.
 */
export class DockerCCRedisClient {
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private config: DockerCCPoolConfig;
  private subscriptions = new Map<
    string,
    {
      channel: string;
      callback: (message: OutputPayload) => void | Promise<void>;
    }
  >();
  private isConnected = false;

  constructor(config: DockerCCPoolConfig) {
    this.config = config;
  }

  /**
   * Connect to Redis.
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;

    const url = resolveRedisUrl(this.config);

    // Main client for commands
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
    });

    // Separate client for subscriptions (Redis requires dedicated connection)
    this.subscriber = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
    });

    await this.client.connect();
    await this.subscriber.connect();

    // Set up message handler for subscriber
    this.subscriber.on("message", (channel: string, message: string) => {
      this.handleSubscriptionMessage(channel, message);
    });

    this.isConnected = true;
  }

  /**
   * Close Redis connections.
   */
  async close(): Promise<void> {
    if (!this.isConnected) return;

    // Unsubscribe from all channels
    for (const [, sub] of this.subscriptions) {
      await this.subscriber?.unsubscribe(sub.channel);
    }
    this.subscriptions.clear();

    await this.client?.quit();
    await this.subscriber?.quit();

    this.client = null;
    this.subscriber = null;
    this.isConnected = false;
  }

  /**
   * Check if connected to Redis.
   */
  isHealthy(): boolean {
    return this.isConnected && this.client?.status === "ready";
  }

  /**
   * Get Redis keys for a session.
   */
  getKeys(sessionKey: string): SessionRedisKeys {
    return getSessionRedisKeys(sessionKey, this.config);
  }

  /**
   * Send input to a session.
   */
  async sendInput(sessionKey: string, input: InputMessage): Promise<void> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);
    await this.client.rpush(keys.input, JSON.stringify(input));
  }

  /**
   * Send interrupt to a session.
   */
  async sendInterrupt(sessionKey: string, interrupt: InterruptMessage): Promise<void> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);

    // Publish to control channel for immediate delivery
    await this.client.publish(keys.control, JSON.stringify(interrupt));

    // Also queue for processing if the session wasn't listening
    await this.client.rpush(keys.interruptQueue, JSON.stringify(interrupt));
  }

  /**
   * Subscribe to session output.
   */
  async subscribeOutput(
    sessionKey: string,
    callback: (message: OutputPayload) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    if (!this.subscriber) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);

    // Store callback
    this.subscriptions.set(sessionKey, {
      channel: keys.output,
      callback,
    });

    // Subscribe to channel
    await this.subscriber.subscribe(keys.output);

    // Return unsubscribe function
    return async () => {
      this.subscriptions.delete(sessionKey);
      await this.subscriber?.unsubscribe(keys.output);
    };
  }

  /**
   * Handle incoming subscription messages.
   */
  private handleSubscriptionMessage(channel: string, message: string): void {
    // Find the matching subscription
    for (const [, sub] of this.subscriptions) {
      if (sub.channel === channel) {
        try {
          const payload = JSON.parse(message) as OutputPayload;
          void Promise.resolve(sub.callback(payload));
        } catch {
          // Invalid JSON, skip
        }
        break;
      }
    }
  }

  /**
   * Get buffered output for a session (for late subscribers).
   */
  async getBufferedOutput(sessionKey: string): Promise<OutputPayload[]> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);
    const messages = await this.client.lrange(keys.outputBuffer, 0, -1);

    return messages
      .map((msg) => {
        try {
          return JSON.parse(msg) as OutputPayload;
        } catch {
          return null;
        }
      })
      .filter((msg): msg is OutputPayload => msg !== null);
  }

  /**
   * Get session state (health status).
   */
  async getSessionState(sessionKey: string): Promise<ContainerHealthStatus | null> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);
    const state = await this.client.hgetall(keys.state);

    if (!state || Object.keys(state).length === 0) {
      return null;
    }

    return {
      sessionId: sessionKey,
      status: state.status as ContainerHealthStatus["status"],
      lastHeartbeat: state.last_heartbeat || state.lastHeartbeat,
      claudeSessionId: state.claude_session_id || state.claudeSessionId,
      turnCount: Number.parseInt(state.turn_count || state.turnCount || "0", 10),
    };
  }

  /**
   * Get session result (final output).
   */
  async getSessionResult(sessionKey: string): Promise<ResultData | null> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);
    const result = await this.client.get(keys.result);

    if (!result) return null;

    try {
      return JSON.parse(result) as ResultData;
    } catch {
      return null;
    }
  }

  /**
   * Wait for session result with timeout.
   */
  async waitForResult(sessionKey: string, timeoutMs: number): Promise<ResultData | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const result = await this.getSessionResult(sessionKey);
      if (result) return result;

      // Check state for completion
      const state = await this.getSessionState(sessionKey);
      if (state?.status === "stopped" || state?.status === "failed") {
        // Session ended, get final result
        return this.getSessionResult(sessionKey);
      }

      // Wait a bit before checking again
      await sleep(500);
    }

    return null;
  }

  /**
   * Clear session data from Redis.
   */
  async clearSessionData(sessionKey: string): Promise<void> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);
    await this.client.del(
      keys.input,
      keys.output,
      keys.outputBuffer,
      keys.state,
      keys.result,
      keys.control,
      keys.interruptQueue,
    );
  }

  /**
   * Publish output message (used by container wrapper when ported).
   * This method is primarily for testing or when running wrapper in-process.
   */
  async publishOutput(sessionKey: string, message: FormattedMessage): Promise<void> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);
    const payload: OutputPayload = {
      type: "output",
      session_id: sessionKey,
      timestamp: new Date().toISOString(),
      data: message,
    };

    const payloadJson = JSON.stringify(payload);

    // Publish to pub/sub channel
    await this.client.publish(keys.output, payloadJson);

    // Buffer for late subscribers
    await this.client.rpush(keys.outputBuffer, payloadJson);
    await this.client.ltrim(keys.outputBuffer, -MAX_OUTPUT_BUFFER, -1);
    await this.client.expire(keys.outputBuffer, SESSION_DATA_EXPIRY_SEC);
  }

  /**
   * Update session state.
   */
  async updateSessionState(
    sessionKey: string,
    state: Partial<ContainerHealthStatus>,
  ): Promise<void> {
    if (!this.client) throw new Error("Not connected to Redis");

    const keys = this.getKeys(sessionKey);
    const mapping: Record<string, string> = {};

    if (state.status) mapping.status = state.status;
    if (state.lastHeartbeat) mapping.last_heartbeat = state.lastHeartbeat;
    if (state.claudeSessionId) mapping.claude_session_id = state.claudeSessionId;
    if (state.turnCount !== undefined) mapping.turn_count = state.turnCount.toString();

    await this.client.hset(keys.state, mapping);
    // Set expiry - if no heartbeat, consider dead
    await this.client.expire(keys.state, 60);
  }

  /**
   * List all active sessions.
   */
  async listActiveSessions(): Promise<string[]> {
    if (!this.client) throw new Error("Not connected to Redis");

    const pattern = `${this.config.redis.keyPrefix}*:state`;
    const keys = await this.client.keys(pattern);

    // Extract session keys from state keys
    return keys
      .map((key) => {
        const match = key.match(
          new RegExp(`^${escapeRegex(this.config.redis.keyPrefix)}(.+):state$`),
        );
        return match?.[1];
      })
      .filter((key): key is string => key !== undefined);
  }

  /**
   * Get ping latency to Redis.
   */
  async ping(): Promise<number> {
    if (!this.client) throw new Error("Not connected to Redis");

    const start = Date.now();
    await this.client.ping();
    return Date.now() - start;
  }
}

/**
 * Sleep for a given duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create a Redis client instance.
 */
export function createRedisClient(config: DockerCCPoolConfig): DockerCCRedisClient {
  return new DockerCCRedisClient(config);
}
