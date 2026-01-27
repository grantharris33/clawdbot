/**
 * Configuration schema and defaults for Docker Claude Code provider.
 */

import type { DockerCCPoolConfig, SessionRedisKeys } from "./types.js";

/**
 * Deep partial type for nested optional fields.
 */
type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

/**
 * Default Docker CC pool configuration.
 */
export const DEFAULT_DOCKER_CC_CONFIG: DockerCCPoolConfig = {
  enabled: false,
  pool: {
    minWarm: 0,
    maxTotal: 10,
    maxPerAgent: 3,
  },
  image: "clawdbot/docker-cc:latest",
  resources: {
    memory: "4g",
    cpus: 2,
    pidsLimit: 256,
  },
  timeouts: {
    idleMs: 5 * 60 * 1000, // 5 minutes
    maxAgeMs: 60 * 60 * 1000, // 1 hour
    healthIntervalMs: 10 * 1000, // 10 seconds
    startupMs: 30 * 1000, // 30 seconds
  },
  redis: {
    url: undefined, // Use REDIS_URL env or default
    keyPrefix: "clawdbot:cc:",
  },
  docker: {
    containerPrefix: "clawdbot-cc-",
    network: "clawdbot-net",
    capDrop: ["ALL"],
    securityOpts: ["no-new-privileges"],
    binds: undefined,
    env: undefined,
  },
};

/**
 * Merge user config with defaults.
 * Accepts deeply partial config to support loose types from Clawdbot config.
 */
export function resolveDockerCCConfig(
  userConfig?: DeepPartial<DockerCCPoolConfig>,
): DockerCCPoolConfig {
  if (!userConfig) {
    return DEFAULT_DOCKER_CC_CONFIG;
  }

  return {
    enabled: userConfig.enabled ?? DEFAULT_DOCKER_CC_CONFIG.enabled,
    pool: {
      ...DEFAULT_DOCKER_CC_CONFIG.pool,
      ...userConfig.pool,
    },
    image: userConfig.image ?? DEFAULT_DOCKER_CC_CONFIG.image,
    resources: {
      ...DEFAULT_DOCKER_CC_CONFIG.resources,
      ...userConfig.resources,
    },
    timeouts: {
      ...DEFAULT_DOCKER_CC_CONFIG.timeouts,
      ...userConfig.timeouts,
    },
    redis: {
      ...DEFAULT_DOCKER_CC_CONFIG.redis,
      ...userConfig.redis,
    },
    docker: {
      containerPrefix:
        userConfig.docker?.containerPrefix ?? DEFAULT_DOCKER_CC_CONFIG.docker.containerPrefix,
      network: userConfig.docker?.network ?? DEFAULT_DOCKER_CC_CONFIG.docker.network,
      capDrop:
        (userConfig.docker?.capDrop?.filter((s): s is string => s !== undefined) as
          | string[]
          | undefined) ?? DEFAULT_DOCKER_CC_CONFIG.docker.capDrop,
      securityOpts:
        (userConfig.docker?.securityOpts?.filter((s): s is string => s !== undefined) as
          | string[]
          | undefined) ?? DEFAULT_DOCKER_CC_CONFIG.docker.securityOpts,
      binds: userConfig.docker?.binds?.filter((s): s is string => s !== undefined) as
        | string[]
        | undefined,
      env: userConfig.docker?.env as Record<string, string> | undefined,
    },
  };
}

/**
 * Get Redis URL from config or environment.
 */
export function resolveRedisUrl(config: DockerCCPoolConfig): string {
  if (config.redis.url) {
    return config.redis.url;
  }
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

/**
 * Generate Redis keys for a session.
 */
export function getSessionRedisKeys(
  sessionKey: string,
  config: DockerCCPoolConfig,
): SessionRedisKeys {
  const prefix = config.redis.keyPrefix;
  const key = `${prefix}${sessionKey}`;
  return {
    input: `${key}:input`,
    output: `${key}:output`,
    outputBuffer: `${key}:output_buffer`,
    state: `${key}:state`,
    result: `${key}:result`,
    control: `${key}:control`,
    interruptQueue: `${key}:interrupt_queue`,
  };
}

/**
 * Generate container name for a session.
 */
export function generateContainerName(sessionKey: string, config: DockerCCPoolConfig): string {
  // Slugify session key for container name safety
  const slug = slugifySessionKey(sessionKey);
  return `${config.docker.containerPrefix}${slug}`;
}

/**
 * Slugify a session key for use in container names.
 * Converts to lowercase, replaces non-alphanumeric with dashes,
 * and truncates to safe length.
 */
export function slugifySessionKey(sessionKey: string): string {
  // Replace non-alphanumeric characters with dashes
  const slug = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

  // Add short hash for uniqueness
  const hash = simpleHash(sessionKey).toString(16).slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * Simple hash function for generating unique suffixes.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a config hash for detecting configuration drift.
 */
export function generateConfigHash(config: DockerCCPoolConfig): string {
  const significant = {
    image: config.image,
    resources: config.resources,
    docker: config.docker,
  };
  return simpleHash(JSON.stringify(significant)).toString(16);
}

/**
 * Docker labels applied to containers.
 */
export interface ContainerLabels {
  "clawdbot.docker-cc": "1";
  "clawdbot.sessionKey": string;
  "clawdbot.agentId"?: string;
  "clawdbot.createdAtMs": string;
  "clawdbot.configHash": string;
}

/**
 * Generate labels for a container.
 */
export function generateContainerLabels(params: {
  sessionKey: string;
  agentId?: string;
  config: DockerCCPoolConfig;
}): ContainerLabels {
  return {
    "clawdbot.docker-cc": "1",
    "clawdbot.sessionKey": params.sessionKey,
    ...(params.agentId && { "clawdbot.agentId": params.agentId }),
    "clawdbot.createdAtMs": Date.now().toString(),
    "clawdbot.configHash": generateConfigHash(params.config),
  };
}

/**
 * Parse container labels back to metadata.
 */
export function parseContainerLabels(labels: Record<string, string>): {
  isDockerCC: boolean;
  sessionKey?: string;
  agentId?: string;
  createdAtMs?: number;
  configHash?: string;
} {
  return {
    isDockerCC: labels["clawdbot.docker-cc"] === "1",
    sessionKey: labels["clawdbot.sessionKey"],
    agentId: labels["clawdbot.agentId"],
    createdAtMs: labels["clawdbot.createdAtMs"]
      ? Number.parseInt(labels["clawdbot.createdAtMs"], 10)
      : undefined,
    configHash: labels["clawdbot.configHash"],
  };
}

/**
 * Default container environment variables.
 */
export function getContainerEnv(params: {
  sessionKey: string;
  redisUrl: string;
  gatewayUrl?: string;
  parentSessionId?: string;
  workspacePath: string;
  claudeModel?: string;
  claudeConfigJson?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    SESSION_ID: params.sessionKey,
    REDIS_URL: params.redisUrl,
    WORKSPACE_PATH: params.workspacePath,
    CLAUDE_CODE_ENTRYPOINT: "clawdbot-docker-cc",
  };

  if (params.gatewayUrl) {
    env.GATEWAY_URL = params.gatewayUrl;
  }

  if (params.parentSessionId) {
    env.PARENT_SESSION_ID = params.parentSessionId;
  }

  if (params.claudeModel) {
    env.CLAUDE_MODEL = params.claudeModel;
  }

  if (params.claudeConfigJson) {
    env.CLAUDE_CONFIG = params.claudeConfigJson;
  }

  return env;
}

/**
 * Validate Docker CC configuration.
 */
export function validateDockerCCConfig(config: DockerCCPoolConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (config.pool.minWarm < 0) {
    errors.push("pool.minWarm must be non-negative");
  }

  if (config.pool.maxTotal < 1) {
    errors.push("pool.maxTotal must be at least 1");
  }

  if (config.pool.minWarm > config.pool.maxTotal) {
    errors.push("pool.minWarm cannot exceed pool.maxTotal");
  }

  if (config.pool.maxPerAgent < 1) {
    errors.push("pool.maxPerAgent must be at least 1");
  }

  if (!config.image) {
    errors.push("image is required");
  }

  if (config.resources.cpus < 0.1) {
    errors.push("resources.cpus must be at least 0.1");
  }

  if (config.resources.pidsLimit < 10) {
    errors.push("resources.pidsLimit must be at least 10");
  }

  if (config.timeouts.healthIntervalMs < 1000) {
    errors.push("timeouts.healthIntervalMs must be at least 1000ms");
  }

  if (config.timeouts.startupMs < 5000) {
    errors.push("timeouts.startupMs must be at least 5000ms");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
