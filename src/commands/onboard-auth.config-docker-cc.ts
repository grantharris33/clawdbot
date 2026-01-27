/**
 * Docker Claude Code configuration helpers for onboarding.
 */

import type { ClawdbotConfig } from "../config/config.js";

/**
 * Default model reference for Docker Claude Code.
 */
export const DOCKER_CC_DEFAULT_MODEL_REF = "docker-claude-code/opus";

/**
 * Check if Docker is available.
 */
export async function checkDockerAvailability(): Promise<{
  available: boolean;
  error?: string;
}> {
  try {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const proc = spawn("docker", ["info"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ available: false, error: "Docker check timed out" });
      }, 5000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ available: true });
        } else {
          resolve({
            available: false,
            error: stderr.trim() || `Docker exited with code ${code}`,
          });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          available: false,
          error: err.message,
        });
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
 * Apply Docker CC provider configuration without changing the default model.
 */
export function applyDockerCCProviderConfig(
  cfg: ClawdbotConfig,
  params?: {
    redisUrl?: string;
    pool?: {
      minWarm?: number;
      maxTotal?: number;
      maxPerAgent?: number;
    };
    image?: string;
  },
): ClawdbotConfig {
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
  cfg: ClawdbotConfig,
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
): ClawdbotConfig {
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
export function disableDockerCCConfig(cfg: ClawdbotConfig): ClawdbotConfig {
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
