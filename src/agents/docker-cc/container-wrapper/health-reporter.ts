/**
 * Health reporter for container wrapper.
 *
 * Port of CC-Docker health.py to TypeScript.
 */

import { Redis } from "ioredis";

/**
 * Health reporter that sends periodic heartbeats to Redis.
 */
export class HealthReporter {
  private redisUrl: string;
  private sessionId: string;
  private interval: number;
  private client: Redis | null = null;
  private running = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(redisUrl: string, sessionId: string, intervalSeconds = 10) {
    this.redisUrl = redisUrl;
    this.sessionId = sessionId;
    this.interval = intervalSeconds * 1000;
  }

  /**
   * Start the health reporter.
   */
  async start(): Promise<void> {
    this.client = new Redis(this.redisUrl, {
      lazyConnect: true,
    });
    await this.client.connect();
    this.running = true;

    // Start periodic reporting
    this.intervalHandle = setInterval(() => {
      void this.report();
    }, this.interval);

    // Report immediately
    await this.report();

    console.log("Health reporter started");
  }

  /**
   * Stop the health reporter.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.client) {
      await this.client.quit();
      this.client = null;
    }

    console.log("Health reporter stopped");
  }

  /**
   * Report current health status.
   */
  private async report(): Promise<void> {
    if (!this.client || !this.running) return;

    try {
      const stateKey = `session:${this.sessionId}:state`;

      await this.client.hset(stateKey, "last_heartbeat", new Date().toISOString());

      // Set expiry on state key (if no heartbeat in 60s, consider dead)
      await this.client.expire(stateKey, 60);
    } catch (err) {
      console.error(`Error reporting health: ${String(err)}`);
    }
  }
}
