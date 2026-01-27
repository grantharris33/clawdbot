/**
 * Redis publisher for container output.
 *
 * Port of CC-Docker redis_publisher.py to TypeScript.
 */

import { Redis } from "ioredis";
import type { InputMessage, InterruptMessage, OutputPayload, ResultPayloadData } from "./types.js";

/**
 * Maximum number of output messages to buffer.
 */
const MAX_OUTPUT_BUFFER = 1000;

/**
 * Default expiry for session data (1 hour).
 */
const SESSION_DATA_EXPIRY_SEC = 3600;

/**
 * Redis publisher for session output.
 */
export class RedisPublisher {
  private redisUrl: string;
  private sessionId: string;
  private client: Redis | null = null;

  constructor(redisUrl: string, sessionId: string) {
    this.redisUrl = redisUrl;
    this.sessionId = sessionId;
  }

  /**
   * Connect to Redis.
   */
  async connect(): Promise<void> {
    this.client = new Redis(this.redisUrl, {
      lazyConnect: true,
    });
    await this.client.connect();
    console.log(`Connected to Redis at ${this.redisUrl}`);
  }

  /**
   * Close Redis connection.
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  /**
   * Publish output message to session channel.
   */
  async publishOutput(message: unknown): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    const payload: OutputPayload = {
      type: "output",
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      data: message,
    };

    const payloadJson = JSON.stringify(payload);

    // Publish to pub/sub channel for real-time streaming
    await this.client.publish(`session:${this.sessionId}:output`, payloadJson);

    // Also buffer output for late subscribers
    const bufferKey = `session:${this.sessionId}:output_buffer`;
    await this.client.rpush(bufferKey, payloadJson);
    // Trim buffer to max size
    await this.client.ltrim(bufferKey, -MAX_OUTPUT_BUFFER, -1);
    // Set expiry on buffer
    await this.client.expire(bufferKey, SESSION_DATA_EXPIRY_SEC);
  }

  /**
   * Publish final result to session channel.
   */
  async publishResult(params: {
    result: string;
    subtype?: "success" | "error";
    usage?: { input_tokens: number; output_tokens: number };
    durationMs?: number;
  }): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    const resultData: ResultPayloadData = {
      subtype: params.subtype ?? "success",
      result: params.result,
      usage: params.usage ?? { input_tokens: 0, output_tokens: 0 },
      duration_ms: params.durationMs,
    };

    const payload: OutputPayload = {
      type: "result",
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      data: resultData,
    };

    const payloadJson = JSON.stringify(payload);

    await this.client.publish(`session:${this.sessionId}:output`, payloadJson);

    // Store result for retrieval
    const resultKey = `session:${this.sessionId}:result`;
    await this.client.set(resultKey, JSON.stringify(resultData));
    await this.client.expire(resultKey, SESSION_DATA_EXPIRY_SEC);
  }

  /**
   * Publish error message to session channel.
   */
  async publishError(error: string): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    const payload: OutputPayload = {
      type: "error",
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      data: { error },
    };

    await this.client.publish(`session:${this.sessionId}:output`, JSON.stringify(payload));
  }

  /**
   * Update session state in Redis.
   */
  async updateState(status: string, extraFields?: Record<string, string>): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    const mapping: Record<string, string> = {
      status,
      last_heartbeat: new Date().toISOString(),
      ...extraFields,
    };

    await this.client.hset(`session:${this.sessionId}:state`, mapping);
  }

  /**
   * Get input from session queue (blocking).
   */
  async getInput(timeout = 0): Promise<InputMessage | null> {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    const result = await this.client.blpop(`session:${this.sessionId}:input`, timeout);

    if (result) {
      try {
        return JSON.parse(result[1]) as InputMessage;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Inject input into the session queue.
   */
  async injectInput(input: InputMessage, highPriority = true): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    const queueKey = `session:${this.sessionId}:input`;

    if (highPriority) {
      // Push to front - will be processed next
      await this.client.lpush(queueKey, JSON.stringify(input));
    } else {
      // Push to back - processed in order
      await this.client.rpush(queueKey, JSON.stringify(input));
    }
  }

  /**
   * Subscribe to control channel.
   */
  subscribeControl(callback: (interrupt: InterruptMessage) => void): () => void {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    // Create a separate subscriber connection
    const subscriber = new Redis(this.redisUrl);
    const channel = `session:${this.sessionId}:control`;

    void subscriber.subscribe(channel);
    subscriber.on("message", (_ch: string, message: string) => {
      try {
        const interrupt = JSON.parse(message) as InterruptMessage;
        callback(interrupt);
      } catch {
        // Invalid message, ignore
      }
    });

    // Return unsubscribe function
    return () => {
      void subscriber.unsubscribe(channel);
      void subscriber.quit();
    };
  }

  /**
   * Get queued interrupts.
   */
  async getQueuedInterrupts(): Promise<InterruptMessage[]> {
    if (!this.client) {
      throw new Error("Not connected to Redis");
    }

    const interrupts: InterruptMessage[] = [];
    const queueKey = `session:${this.sessionId}:interrupt_queue`;

    while (true) {
      const data = await this.client.lpop(queueKey);
      if (!data) break;

      try {
        interrupts.push(JSON.parse(data) as InterruptMessage);
      } catch {
        // Invalid message, skip
      }
    }

    return interrupts;
  }
}
