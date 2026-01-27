/**
 * Container wrapper entry point.
 *
 * This is the main process that runs inside Docker containers.
 * Port of CC-Docker main.py to TypeScript.
 */

import type { InterruptMessage, WrapperConfig } from "./types.js";
import { loadConfigFromEnv } from "./config.js";
import { RedisPublisher } from "./redis-publisher.js";
import { InteractiveRunner } from "./claude-runner.js";
import { HealthReporter } from "./health-reporter.js";
import { ConfigGenerator } from "./config-generator.js";

/**
 * Interrupt listener for handling parent interrupts.
 */
class InterruptListener {
  private publisher: RedisPublisher;
  private unsubscribe: (() => void) | null = null;
  private callbacks: Array<(interrupt: InterruptMessage) => Promise<void>> = [];

  constructor(publisher: RedisPublisher) {
    this.publisher = publisher;
  }

  /**
   * Start listening for interrupts.
   */
  async start(): Promise<void> {
    // Subscribe to control channel
    this.unsubscribe = this.publisher.subscribeControl((interrupt) => {
      void this.handleInterrupt(interrupt);
    });

    // Process any queued interrupts
    const queued = await this.publisher.getQueuedInterrupts();
    for (const interrupt of queued) {
      console.log(`Processing queued interrupt: ${JSON.stringify(interrupt)}`);
      await this.handleInterrupt(interrupt);
    }

    console.log("Interrupt listener started");
  }

  /**
   * Stop listening for interrupts.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Register a callback for interrupts.
   */
  onInterrupt(callback: (interrupt: InterruptMessage) => Promise<void>): void {
    this.callbacks.push(callback);
  }

  /**
   * Handle an interrupt message.
   */
  private async handleInterrupt(interrupt: InterruptMessage): Promise<void> {
    console.log(`Received interrupt: ${JSON.stringify(interrupt)}`);
    for (const callback of this.callbacks) {
      try {
        await callback(interrupt);
      } catch (err) {
        console.error(`Interrupt callback error: ${String(err)}`);
      }
    }
  }
}

/**
 * Main wrapper application.
 */
class WrapperApp {
  private config: WrapperConfig | null = null;
  private publisher: RedisPublisher | null = null;
  private runner: InteractiveRunner | null = null;
  private health: HealthReporter | null = null;
  private interruptListener: InterruptListener | null = null;

  /**
   * Start the wrapper application.
   */
  async start(): Promise<void> {
    try {
      // Load configuration
      this.config = loadConfigFromEnv();
      console.log(`Starting wrapper for session ${this.config.sessionId}`);

      // Generate Claude Code configuration files
      await this.generateConfigFiles();

      // Initialize Redis publisher
      this.publisher = new RedisPublisher(this.config.redisUrl, this.config.sessionId);
      await this.publisher.connect();

      // Start health reporter
      this.health = new HealthReporter(this.config.redisUrl, this.config.sessionId);
      await this.health.start();

      // Start interrupt listener
      this.interruptListener = new InterruptListener(this.publisher);
      this.interruptListener.onInterrupt(async (interrupt) => {
        await this.handleInterrupt(interrupt);
      });
      await this.interruptListener.start();

      // Start interactive runner
      this.runner = new InteractiveRunner(this.config, this.publisher);
      await this.runner.run();
    } catch (err) {
      console.error(`Fatal error: ${String(err)}`);
      if (this.publisher) {
        await this.publisher.publishError(String(err));
        await this.publisher.updateState("failed");
      }
      throw err;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Handle an interrupt message.
   */
  private async handleInterrupt(interrupt: InterruptMessage): Promise<void> {
    const priority = interrupt.priority ?? "normal";
    console.log(`Processing interrupt: type=${interrupt.type}, priority=${priority}`);

    switch (interrupt.type) {
      case "stop":
        await this.shutdown();
        break;

      case "redirect":
        if (interrupt.message && this.runner) {
          const interruptPrompt = `[INTERRUPT FROM PARENT - ${priority.toUpperCase()} PRIORITY]\n\n${interrupt.message}`;
          await this.runner.injectPrompt(interruptPrompt);
        }
        break;

      case "pause":
        if (this.runner) {
          await this.runner.pause();
        }
        break;

      case "resume":
        if (this.runner) {
          await this.runner.resume();
        }
        break;

      default:
        console.warn(`Unknown interrupt type: ${String((interrupt as { type: string }).type)}`);
    }
  }

  /**
   * Generate Claude Code configuration files.
   */
  private async generateConfigFiles(): Promise<void> {
    if (!this.config) return;

    try {
      const generator = new ConfigGenerator({
        sessionId: this.config.sessionId,
        workspacePath: this.config.workspacePath,
        redisUrl: this.config.redisUrl,
        gatewayUrl: this.config.gatewayUrl,
        parentSessionId: this.config.parentSessionId,
        containerRole: this.config.parentSessionId ? "child" : "root",
        mcpServers: this.config.claudeConfig?.mcpServers,
      });
      await generator.generateAll();
    } catch (err) {
      console.error(`Failed to generate configuration files: ${String(err)}`);
      // Don't fail startup - Claude Code can still work without these files
    }
  }

  /**
   * Clean up resources.
   */
  private async cleanup(): Promise<void> {
    console.log("Cleaning up...");

    if (this.runner) {
      await this.runner.stop();
    }

    if (this.interruptListener) {
      this.interruptListener.stop();
    }

    if (this.health) {
      await this.health.stop();
    }

    if (this.publisher) {
      await this.publisher.updateState("stopped");
      await this.publisher.close();
    }
  }

  /**
   * Handle graceful shutdown.
   */
  async shutdown(): Promise<void> {
    console.log("Shutdown requested");
    if (this.runner) {
      await this.runner.stop();
    }
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<number> {
  const app = new WrapperApp();

  // Set up signal handlers
  const signalHandler = () => {
    console.log("Signal received, shutting down...");
    void app.shutdown();
  };

  process.on("SIGTERM", signalHandler);
  process.on("SIGINT", signalHandler);

  try {
    await app.start();
    return 0;
  } catch (err) {
    console.error(`Wrapper failed: ${String(err)}`);
    return 1;
  }
}

// Run if executed directly
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
