/**
 * Docker Claude Code configuration helpers for onboarding.
 *
 * Provides both config manipulation and Docker infrastructure setup.
 */

import type { MoltbotConfig } from "../config/config.js";

/**
 * Default model reference for Docker Claude Code.
 */
export const DOCKER_CC_DEFAULT_MODEL_REF = "docker-claude-code/opus";

/**
 * Default Docker CC image.
 */
export const DOCKER_CC_DEFAULT_IMAGE = "clawdbot/docker-cc:latest";

/**
 * Default Docker network for Docker CC.
 */
export const DOCKER_CC_DEFAULT_NETWORK = "clawdbot-net";

/**
 * Default Redis container name.
 */
export const DOCKER_CC_REDIS_CONTAINER_NAME = "clawdbot-redis";

/**
 * Spawn a Docker command and return the result.
 */
async function runDockerCommand(
  args: string[],
  options?: { timeout?: number },
): Promise<{ success: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const proc = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ success: false, stdout, stderr, error: "Command timed out" });
      }, options?.timeout ?? 30000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: code !== 0 ? stderr.trim() || `Exit code ${code}` : undefined,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          stdout,
          stderr,
          error: err.message,
        });
      });
    });
  } catch (err) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if Docker is available.
 */
export async function checkDockerAvailability(): Promise<{
  available: boolean;
  error?: string;
}> {
  const result = await runDockerCommand(["info"], { timeout: 10000 });
  return {
    available: result.success,
    error: result.error,
  };
}

/**
 * Check if Redis is available at the given URL.
 */
export async function checkRedisAvailability(
  url: string,
): Promise<{ available: boolean; error?: string }> {
  try {
    // Parse the URL to get host and port
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = Number.parseInt(parsed.port || "6379", 10);

    // Try to connect via TCP
    const { createConnection } = await import("node:net");
    return new Promise((resolve) => {
      const socket = createConnection({ host, port }, () => {
        // Send PING command
        socket.write("PING\r\n");
      });

      socket.setTimeout(5000);

      socket.on("data", (data) => {
        const response = data.toString();
        socket.destroy();
        if (response.includes("+PONG") || response.includes("PONG")) {
          resolve({ available: true });
        } else {
          resolve({ available: false, error: `Unexpected response: ${response}` });
        }
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve({ available: false, error: "Connection timeout" });
      });

      socket.on("error", (err) => {
        socket.destroy();
        resolve({ available: false, error: err.message });
      });
    });
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create a Docker network.
 */
export async function createDockerNetwork(
  name: string,
): Promise<{ success: boolean; alreadyExists: boolean; error?: string }> {
  // Check if network already exists
  const inspectResult = await runDockerCommand(["network", "inspect", name]);
  if (inspectResult.success) {
    return { success: true, alreadyExists: true };
  }

  // Create the network
  const createResult = await runDockerCommand(["network", "create", name]);
  if (createResult.success) {
    return { success: true, alreadyExists: false };
  }

  // Check if it failed because it already exists (race condition)
  if (createResult.stderr?.includes("already exists")) {
    return { success: true, alreadyExists: true };
  }

  return { success: false, alreadyExists: false, error: createResult.error };
}

/**
 * Start a Redis container.
 */
export async function startRedisContainer(params: {
  containerName: string;
  network: string;
  port: number;
}): Promise<{ success: boolean; alreadyRunning: boolean; error?: string }> {
  // Check if container already exists and is running
  const inspectResult = await runDockerCommand([
    "inspect",
    "--format",
    "{{.State.Running}}",
    params.containerName,
  ]);

  if (inspectResult.success) {
    if (inspectResult.stdout === "true") {
      return { success: true, alreadyRunning: true };
    }
    // Container exists but not running, start it
    const startResult = await runDockerCommand(["start", params.containerName]);
    if (startResult.success) {
      return { success: true, alreadyRunning: false };
    }
    return { success: false, alreadyRunning: false, error: startResult.error };
  }

  // Container doesn't exist, create and start it
  const runResult = await runDockerCommand(
    [
      "run",
      "-d",
      "--name",
      params.containerName,
      "--network",
      params.network,
      "-p",
      `${params.port}:6379`,
      "--restart",
      "unless-stopped",
      "redis:alpine",
    ],
    { timeout: 60000 },
  );

  if (runResult.success) {
    return { success: true, alreadyRunning: false };
  }

  // Check if it failed because container already exists (race condition)
  if (runResult.stderr?.includes("already in use")) {
    // Try to start it
    const startResult = await runDockerCommand(["start", params.containerName]);
    if (startResult.success) {
      return { success: true, alreadyRunning: false };
    }
  }

  return { success: false, alreadyRunning: false, error: runResult.error };
}

/**
 * Pull a Docker image.
 */
export async function pullDockerCCImage(
  image: string,
): Promise<{ success: boolean; error?: string }> {
  // First check if image already exists
  const inspectResult = await runDockerCommand(["image", "inspect", image]);
  if (inspectResult.success) {
    return { success: true }; // Image already exists
  }

  // Pull the image (this can take a while)
  const pullResult = await runDockerCommand(["pull", image], { timeout: 300000 }); // 5 minute timeout
  return {
    success: pullResult.success,
    error: pullResult.error,
  };
}

/**
 * Apply Docker CC provider configuration without changing the default model.
 */
export function applyDockerCCProviderConfig(
  cfg: MoltbotConfig,
  params?: {
    redisUrl?: string;
    pool?: {
      minWarm?: number;
      maxTotal?: number;
      maxPerAgent?: number;
    };
    image?: string;
  },
): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[DOCKER_CC_DEFAULT_MODEL_REF] = {
    ...models[DOCKER_CC_DEFAULT_MODEL_REF],
    alias: models[DOCKER_CC_DEFAULT_MODEL_REF]?.alias ?? "Docker CC",
  };

  const existingDockerCC = cfg.agents?.defaults?.dockerClaudeCode;
  const dockerClaudeCode = {
    ...existingDockerCC,
    enabled: true,
    ...(params?.redisUrl && {
      redis: {
        ...existingDockerCC?.redis,
        url: params.redisUrl,
      },
    }),
    ...(params?.pool && {
      pool: {
        ...existingDockerCC?.pool,
        ...(params.pool.minWarm !== undefined && { minWarm: params.pool.minWarm }),
        ...(params.pool.maxTotal !== undefined && { maxTotal: params.pool.maxTotal }),
        ...(params.pool.maxPerAgent !== undefined && { maxPerAgent: params.pool.maxPerAgent }),
      },
    }),
    ...(params?.image && { image: params.image }),
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        dockerClaudeCode,
      },
    },
  };
}

/**
 * Apply Docker CC provider configuration AND set it as the default model.
 */
export function applyDockerCCConfig(
  cfg: MoltbotConfig,
  params?: {
    enabled?: boolean;
    redisUrl?: string;
    pool?: {
      minWarm?: number;
      maxTotal?: number;
      maxPerAgent?: number;
    };
    image?: string;
  },
): MoltbotConfig {
  const next = applyDockerCCProviderConfig(cfg, params);
  const existingModel = next.agents?.defaults?.model;

  // Set Docker CC as primary with existing model as fallback
  const existingPrimary =
    existingModel && typeof existingModel === "object" && "primary" in existingModel
      ? (existingModel as { primary?: string }).primary
      : typeof existingModel === "string"
        ? existingModel
        : undefined;

  const existingFallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;

  // Build fallback chain: existing primary + existing fallbacks (if any)
  const fallbacks = [
    ...(existingPrimary && existingPrimary !== DOCKER_CC_DEFAULT_MODEL_REF
      ? [existingPrimary]
      : []),
    ...(existingFallbacks?.filter((f) => f !== DOCKER_CC_DEFAULT_MODEL_REF) ?? []),
  ];

  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          primary: DOCKER_CC_DEFAULT_MODEL_REF,
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
        },
      },
    },
  };
}

/**
 * Disable Docker CC provider.
 */
export function disableDockerCCConfig(cfg: MoltbotConfig): MoltbotConfig {
  const existingDockerCC = cfg.agents?.defaults?.dockerClaudeCode;
  if (!existingDockerCC) return cfg;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        dockerClaudeCode: {
          ...existingDockerCC,
          enabled: false,
        },
      },
    },
  };
}
