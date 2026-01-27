/**
 * Health monitoring for Docker CC containers.
 *
 * Provides health checks at multiple levels:
 * - Redis connectivity
 * - Docker daemon availability
 * - Individual container health via Redis heartbeats
 * - Pool-level health metrics
 */

import type { ContainerHealthStatus, DockerCCPoolConfig } from "./types.js";
import { isDockerAvailable } from "./container.js";
import { DockerCCRedisClient } from "./redis-client.js";
import type { DockerCCPoolManager } from "./pool-manager.js";

/**
 * Health check result.
 */
export interface HealthCheckResult {
  healthy: boolean;
  checks: {
    docker: boolean;
    redis: boolean;
    pool: boolean;
  };
  details: {
    dockerError?: string;
    redisError?: string;
    redisLatencyMs?: number;
    poolStats?: {
      total: number;
      active: number;
      warm: number;
    };
  };
}

/**
 * Container health check result.
 */
export interface ContainerHealthCheckResult {
  healthy: boolean;
  status: ContainerHealthStatus | null;
  lastHeartbeatAgeMs: number | null;
  isStale: boolean;
}

/**
 * Health monitor for Docker CC system.
 */
export class DockerCCHealthMonitor {
  private config: DockerCCPoolConfig;
  private redisClient: DockerCCRedisClient | null = null;
  private poolManager: DockerCCPoolManager | null = null;

  constructor(config: DockerCCPoolConfig) {
    this.config = config;
  }

  /**
   * Set the Redis client for health monitoring.
   */
  setRedisClient(client: DockerCCRedisClient): void {
    this.redisClient = client;
  }

  /**
   * Set the pool manager for health monitoring.
   */
  setPoolManager(manager: DockerCCPoolManager): void {
    this.poolManager = manager;
  }

  /**
   * Perform a full health check.
   */
  async check(): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {
      healthy: false,
      checks: {
        docker: false,
        redis: false,
        pool: false,
      },
      details: {},
    };

    // Check Docker
    try {
      result.checks.docker = await isDockerAvailable();
    } catch (err) {
      result.checks.docker = false;
      result.details.dockerError = err instanceof Error ? err.message : String(err);
    }

    // Check Redis
    if (this.redisClient) {
      try {
        const latency = await this.redisClient.ping();
        result.checks.redis = true;
        result.details.redisLatencyMs = latency;
      } catch (err) {
        result.checks.redis = false;
        result.details.redisError = err instanceof Error ? err.message : String(err);
      }
    } else {
      // Try a one-off connection
      try {
        const tempClient = new DockerCCRedisClient(this.config);
        await tempClient.connect();
        const latency = await tempClient.ping();
        await tempClient.close();
        result.checks.redis = true;
        result.details.redisLatencyMs = latency;
      } catch (err) {
        result.checks.redis = false;
        result.details.redisError = err instanceof Error ? err.message : String(err);
      }
    }

    // Check pool
    if (this.poolManager) {
      result.checks.pool = this.poolManager.isHealthy();
      result.details.poolStats = this.poolManager.getStats();
    } else {
      result.checks.pool = true; // No pool manager means pool check passes vacuously
    }

    // Overall health
    result.healthy = result.checks.docker && result.checks.redis && result.checks.pool;

    return result;
  }

  /**
   * Check health of a specific container.
   */
  async checkContainer(sessionKey: string): Promise<ContainerHealthCheckResult> {
    if (!this.redisClient) {
      return {
        healthy: false,
        status: null,
        lastHeartbeatAgeMs: null,
        isStale: true,
      };
    }

    const status = await this.redisClient.getSessionState(sessionKey);

    if (!status) {
      return {
        healthy: false,
        status: null,
        lastHeartbeatAgeMs: null,
        isStale: true,
      };
    }

    const lastHeartbeatAgeMs = status.lastHeartbeat
      ? Date.now() - new Date(status.lastHeartbeat).getTime()
      : null;

    const staleThreshold = this.config.timeouts.healthIntervalMs * 3;
    const isStale = lastHeartbeatAgeMs !== null && lastHeartbeatAgeMs > staleThreshold;

    const healthy = (status.status === "idle" || status.status === "running") && !isStale;

    return {
      healthy,
      status,
      lastHeartbeatAgeMs,
      isStale,
    };
  }

  /**
   * Check if Docker CC is available and healthy for use.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.check();
      return health.healthy;
    } catch {
      return false;
    }
  }

  /**
   * Get quick availability check (cached/fast).
   */
  isQuickAvailable(): boolean {
    // Check if essential components are set up
    const hasDocker = true; // Assume true if we got this far
    const hasRedis = this.redisClient?.isHealthy() ?? false;
    const hasPool = this.poolManager?.isHealthy() ?? true;

    return hasDocker && hasRedis && hasPool;
  }
}

/**
 * Create a health monitor instance.
 */
export function createHealthMonitor(config: DockerCCPoolConfig): DockerCCHealthMonitor {
  return new DockerCCHealthMonitor(config);
}

/**
 * Parse heartbeat timestamp to age in milliseconds.
 */
export function parseHeartbeatAge(timestamp: string | undefined): number | null {
  if (!timestamp) return null;

  try {
    const date = new Date(timestamp);
    return Date.now() - date.getTime();
  } catch {
    return null;
  }
}

/**
 * Determine if a heartbeat is stale.
 */
export function isHeartbeatStale(timestamp: string | undefined, thresholdMs: number): boolean {
  const age = parseHeartbeatAge(timestamp);
  if (age === null) return true;
  return age > thresholdMs;
}

/**
 * Format health check result for display.
 */
export function formatHealthCheckResult(result: HealthCheckResult): string {
  const lines: string[] = [];

  lines.push(`Docker CC Health: ${result.healthy ? "✓ Healthy" : "✗ Unhealthy"}`);
  lines.push("");
  lines.push("Checks:");
  lines.push(
    `  Docker: ${result.checks.docker ? "✓" : "✗"}${result.details.dockerError ? ` (${result.details.dockerError})` : ""}`,
  );
  lines.push(
    `  Redis: ${result.checks.redis ? "✓" : "✗"}${result.details.redisError ? ` (${result.details.redisError})` : ""}${result.details.redisLatencyMs !== undefined ? ` (${result.details.redisLatencyMs}ms)` : ""}`,
  );
  lines.push(`  Pool: ${result.checks.pool ? "✓" : "✗"}`);

  if (result.details.poolStats) {
    const stats = result.details.poolStats;
    lines.push("");
    lines.push("Pool Stats:");
    lines.push(`  Total: ${stats.total}`);
    lines.push(`  Active: ${stats.active}`);
    lines.push(`  Warm: ${stats.warm}`);
  }

  return lines.join("\n");
}
