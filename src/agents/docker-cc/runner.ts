/**
 * Main Docker CC runner.
 *
 * This module provides the high-level interface for running prompts through
 * Docker Claude Code containers. It orchestrates the pool manager, Redis
 * communication, and streaming output.
 */

import type {
  ClaudeContainerConfig,
  ClaudeRunResult,
  ContainerHealthStatus,
  DockerCCPoolConfig,
  DockerCCProvider,
  DockerCCRunOptions,
  FormattedMessage,
  InputMessage,
  InterruptMessage,
  OutputPayload,
} from "./types.js";
import { resolveDockerCCConfig } from "./config.js";
import { createRedisClient, DockerCCRedisClient } from "./redis-client.js";
import { createPoolManager, DockerCCPoolManager } from "./pool-manager.js";
import { createHealthMonitor, DockerCCHealthMonitor } from "./health.js";

/**
 * Default run timeout (10 minutes).
 */
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Docker CC runner implementation.
 */
export class DockerCCRunner implements DockerCCProvider {
  private config: DockerCCPoolConfig;
  private redisClient: DockerCCRedisClient;
  private poolManager: DockerCCPoolManager;
  private healthMonitor: DockerCCHealthMonitor;
  private isInitialized = false;

  constructor(config?: Partial<DockerCCPoolConfig>) {
    this.config = resolveDockerCCConfig(config);
    this.redisClient = createRedisClient(this.config);
    this.poolManager = createPoolManager(this.config);
    this.healthMonitor = createHealthMonitor(this.config);
  }

  /**
   * Initialize the runner (connect to Redis, start pool manager).
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Connect to Redis
    await this.redisClient.connect();

    // Set up health monitor
    this.healthMonitor.setRedisClient(this.redisClient);
    this.healthMonitor.setPoolManager(this.poolManager);

    // Start pool manager
    await this.poolManager.start();

    this.isInitialized = true;
  }

  /**
   * Check if provider is available and healthy.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (!this.isInitialized) {
      try {
        await this.initialize();
      } catch {
        return false;
      }
    }
    return this.healthMonitor.isAvailable();
  }

  /**
   * Run a prompt through Docker Claude Code.
   */
  async run(options: DockerCCRunOptions): Promise<ClaudeRunResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const {
      sessionKey,
      agentId,
      prompt,
      images,
      workspaceDir,
      extraSystemPrompt,
      model,
      timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
      onOutput,
      onResult,
    } = options;

    // Build Claude config for container
    const claudeConfig: ClaudeContainerConfig = {
      model,
      systemPrompt: extraSystemPrompt,
      permissionMode: "bypassPermissions",
    };

    // Get or create a container for this session
    const _assignment = await this.poolManager.getContainer({
      sessionKey,
      agentId,
      workspaceDir,
      claudeConfig,
    });

    // Subscribe to output stream
    let unsubscribe: (() => Promise<void>) | null = null;
    const outputBuffer: FormattedMessage[] = [];

    if (onOutput) {
      unsubscribe = await this.redisClient.subscribeOutput(
        sessionKey,
        async (payload: OutputPayload) => {
          if (payload.type === "output" && payload.data) {
            const formatted = payload.data as FormattedMessage;
            outputBuffer.push(formatted);
            await onOutput(formatted);
          }
        },
      );
    }

    try {
      // Send input to container
      const input: InputMessage = {
        prompt,
        images,
      };
      await this.redisClient.sendInput(sessionKey, input);

      // Wait for result
      const resultData = await this.redisClient.waitForResult(sessionKey, timeoutMs);

      const result: ClaudeRunResult = {
        result: resultData?.result ?? null,
        usage: resultData?.usage ?? { input_tokens: 0, output_tokens: 0 },
        duration_ms: resultData?.duration_ms ?? 0,
        exit_code: resultData?.subtype === "error" ? 1 : 0,
      };

      // Get Claude session ID for resume support
      const state = await this.redisClient.getSessionState(sessionKey);
      if (state?.claudeSessionId) {
        result.claudeSessionId = state.claudeSessionId;
      }

      if (onResult) {
        await onResult(result);
      }

      return result;
    } finally {
      // Unsubscribe from output
      if (unsubscribe) {
        await unsubscribe();
      }
    }
  }

  /**
   * Stop a session.
   */
  async stop(sessionKey: string): Promise<void> {
    // Send stop interrupt
    await this.sendInterrupt(sessionKey, { type: "stop" });

    // Release the container
    await this.poolManager.releaseContainer(sessionKey, { returnToPool: true });
  }

  /**
   * Get session status.
   */
  async getStatus(sessionKey: string): Promise<ContainerHealthStatus | null> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    return this.redisClient.getSessionState(sessionKey);
  }

  /**
   * Send interrupt to session.
   */
  async sendInterrupt(sessionKey: string, interrupt: InterruptMessage): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    await this.redisClient.sendInterrupt(sessionKey, interrupt);
  }

  /**
   * Shutdown provider and cleanup.
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) return;

    await this.poolManager.shutdown();
    await this.redisClient.close();
    this.isInitialized = false;
  }

  /**
   * Get pool statistics.
   */
  getStats(): {
    total: number;
    active: number;
    warm: number;
    maxTotal: number;
    maxPerAgent: number;
  } {
    return this.poolManager.getStats();
  }

  /**
   * Get configuration.
   */
  getConfig(): DockerCCPoolConfig {
    return this.config;
  }

  /**
   * Check if runner is initialized.
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

/**
 * Create a Docker CC runner instance.
 */
export function createDockerCCRunner(config?: Partial<DockerCCPoolConfig>): DockerCCRunner {
  return new DockerCCRunner(config);
}

/**
 * Singleton instance for shared use.
 */
let sharedRunner: DockerCCRunner | null = null;

/**
 * Get the shared Docker CC runner instance.
 */
export function getSharedRunner(config?: Partial<DockerCCPoolConfig>): DockerCCRunner {
  if (!sharedRunner) {
    sharedRunner = createDockerCCRunner(config);
  }
  return sharedRunner;
}

/**
 * Reset the shared runner (for testing).
 */
export async function resetSharedRunner(): Promise<void> {
  if (sharedRunner) {
    await sharedRunner.shutdown();
    sharedRunner = null;
  }
}

/**
 * Helper function to run a single prompt through Docker CC.
 * Handles initialization and cleanup.
 */
export async function runDockerCC(
  options: DockerCCRunOptions & { config?: Partial<DockerCCPoolConfig> },
): Promise<ClaudeRunResult> {
  const runner = getSharedRunner(options.config);
  return runner.run(options);
}

/**
 * Check if Docker CC is available.
 */
export async function isDockerCCAvailable(config?: Partial<DockerCCPoolConfig>): Promise<boolean> {
  const resolved = resolveDockerCCConfig(config);
  if (!resolved.enabled) return false;

  const runner = getSharedRunner(config);
  return runner.isAvailable();
}
