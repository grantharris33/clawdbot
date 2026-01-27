/**
 * Docker Claude Code provider.
 *
 * This module provides a Docker-based Claude Code provider that runs Claude Code
 * CLI in isolated containers with Redis-based communication.
 *
 * ## Architecture
 *
 * ```
 * Clawdbot Gateway
 *   └── DockerCCRunner (this module)
 *         ├── PoolManager (container lifecycle)
 *         ├── RedisClient (communication)
 *         └── HealthMonitor (health checks)
 *               │
 *               ▼ Docker + Redis
 *         Docker Container Pool
 *           └── Container Wrapper (TypeScript)
 *                 └── Claude Code CLI
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import {createDockerCCRunner, isDockerCCAvailable} from "./agents/docker-cc"
 *
 * // Check availability
 * if (await isDockerCCAvailable()) {
 *   const runner = createDockerCCRunner({enabled: true})
 *
 *   const result = await runner.run({
 *     sessionKey: "session-123",
 *     prompt: "Hello, Claude!",
 *     workspaceDir: "/path/to/workspace",
 *     onOutput: (msg) => console.log("Output:", msg),
 *   })
 *
 *   console.log("Result:", result)
 * }
 * ```
 *
 * ## Configuration
 *
 * ```yaml
 * agents:
 *   defaults:
 *     dockerClaudeCode:
 *       enabled: true
 *       pool:
 *         minWarm: 2
 *         maxTotal: 10
 *         maxPerAgent: 3
 *       image: clawdbot/docker-cc:latest
 *       resources:
 *         memory: 4g
 *         cpus: 2
 *       redis:
 *         url: redis://localhost:6379
 * ```
 *
 * @module docker-cc
 */

// Types
export type {
  ClaudeContainerConfig,
  ClaudeRunResult,
  ContainerAssignment,
  ContainerCreateOptions,
  ContainerHealthStatus,
  ContainerRegistryEntry,
  ContainerStatus,
  DockerCCPoolConfig,
  DockerCCProvider,
  DockerCCRunOptions,
  FormattedMessage,
  ImageInput,
  InputMessage,
  InterruptMessage,
  McpServerConfig,
  OutputPayload,
  PoolState,
  ResultData,
  SessionRedisKeys,
  StreamMessage,
  StreamMessageType,
} from "./types.js";

// Configuration
export {
  DEFAULT_DOCKER_CC_CONFIG,
  generateConfigHash,
  generateContainerLabels,
  generateContainerName,
  getContainerEnv,
  getSessionRedisKeys,
  parseContainerLabels,
  resolveDockerCCConfig,
  resolveRedisUrl,
  slugifySessionKey,
  validateDockerCCConfig,
} from "./config.js";

// Stream parser
export {
  extractMessageType,
  extractSessionId,
  extractUsage,
  formatForClient,
  isCompletionMessage,
  isErrorMessage,
  parseJsonl,
  parseStream,
  StreamParser,
} from "./stream-parser.js";

// Redis client
export { createRedisClient, DockerCCRedisClient } from "./redis-client.js";

// Container management
export {
  buildContainerCreateArgs,
  checkContainerConfig,
  createAndStartContainer,
  createContainer,
  dockerImageExists,
  ensureContainer,
  ensureDockerImage,
  execDocker,
  execInContainer,
  getContainerId,
  getContainerLabels,
  getContainerLogs,
  getContainerState,
  isDockerAvailable,
  listContainers,
  pullDockerImage,
  removeContainer,
  startContainer,
  stopContainer,
  waitForContainerReady,
} from "./container.js";

// Registry
export {
  assignContainerToSession,
  clearRegistry,
  getContainerBySessionKey,
  getContainerEntry,
  getExpiredContainers,
  getIdleContainers,
  getStaleContainers,
  listContainerEntries,
  listContainersByAgent,
  listWarmContainers,
  readRegistry,
  removeContainerEntry,
  syncWithDocker,
  unassignContainer,
  updateContainerEntry,
  updateContainerHeartbeat,
  updateContainerStatus,
  writeRegistry,
} from "./registry.js";

// Pool manager
export { createPoolManager, DockerCCPoolManager } from "./pool-manager.js";

// Health monitoring
export {
  createHealthMonitor,
  DockerCCHealthMonitor,
  formatHealthCheckResult,
  isHeartbeatStale,
  parseHeartbeatAge,
} from "./health.js";
export type { ContainerHealthCheckResult, HealthCheckResult } from "./health.js";

// Main runner
export {
  createDockerCCRunner,
  DockerCCRunner,
  getSharedRunner,
  isDockerCCAvailable,
  resetSharedRunner,
  runDockerCC,
} from "./runner.js";
