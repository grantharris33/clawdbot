/**
 * Type definitions for Docker Claude Code provider.
 *
 * This module defines all the types used for managing Docker containers
 * running Claude Code CLI with Redis-based communication.
 */

/**
 * Configuration for the Docker CC container pool.
 */
export interface DockerCCPoolConfig {
  /** Whether Docker CC is enabled */
  enabled: boolean;
  /** Pool sizing configuration */
  pool: {
    /** Minimum warm containers to maintain */
    minWarm: number;
    /** Maximum total containers allowed */
    maxTotal: number;
    /** Maximum containers per agent */
    maxPerAgent: number;
  };
  /** Docker image to use */
  image: string;
  /** Container resource limits */
  resources: {
    /** Memory limit (e.g., "4g", "2048m") */
    memory: string;
    /** CPU limit (e.g., 2.0) */
    cpus: number;
    /** Max PIDs in container */
    pidsLimit: number;
  };
  /** Timeout configuration */
  timeouts: {
    /** Idle timeout before container cleanup (ms) */
    idleMs: number;
    /** Maximum container age (ms) */
    maxAgeMs: number;
    /** Health check interval (ms) */
    healthIntervalMs: number;
    /** Container startup timeout (ms) */
    startupMs: number;
  };
  /** Redis configuration */
  redis: {
    /** Redis connection URL */
    url?: string;
    /** Key prefix for all Redis keys */
    keyPrefix: string;
  };
  /** Docker-specific configuration */
  docker: {
    /** Container name prefix */
    containerPrefix: string;
    /** Docker network name */
    network: string;
    /** Capabilities to drop */
    capDrop: string[];
    /** Security options */
    securityOpts: string[];
    /** Additional volume binds */
    binds?: string[];
    /** Additional environment variables */
    env?: Record<string, string>;
  };
}

/**
 * Container status values.
 */
export type ContainerStatus =
  | "creating"
  | "starting"
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

/**
 * Container registry entry (persisted to disk).
 */
export interface ContainerRegistryEntry {
  /** Container ID (Docker ID) */
  containerId: string;
  /** Container name */
  containerName: string;
  /** Session key this container is assigned to (or null if warm) */
  sessionKey: string | null;
  /** Agent ID if assigned */
  agentId?: string;
  /** Current status */
  status: ContainerStatus;
  /** Creation timestamp */
  createdAt: number;
  /** Last heartbeat timestamp */
  lastHeartbeat: number;
  /** Claude Code session ID (for resume) */
  claudeSessionId?: string;
  /** Turn count in current session */
  turnCount: number;
  /** Config hash for detecting drift */
  configHash: string;
}

/**
 * Health status from Redis heartbeat.
 */
export interface ContainerHealthStatus {
  /** Session ID */
  sessionId: string;
  /** Current status */
  status: ContainerStatus;
  /** Last heartbeat ISO timestamp */
  lastHeartbeat: string;
  /** Claude session ID for resume */
  claudeSessionId?: string;
  /** Turn count */
  turnCount: number;
}

/**
 * Redis channel/key schema for a session.
 */
export interface SessionRedisKeys {
  /** Input queue (RPUSH/BLPOP) */
  input: string;
  /** Output pub/sub channel */
  output: string;
  /** Output buffer list (for late subscribers) */
  outputBuffer: string;
  /** State hash (status, heartbeat, claude_session_id) */
  state: string;
  /** Final result string */
  result: string;
  /** Control pub/sub (stop/redirect/pause) */
  control: string;
  /** Interrupt queue */
  interruptQueue: string;
}

/**
 * Message types in the Claude Code stream-json output.
 */
export type StreamMessageType =
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "result"
  | "system"
  | "error"
  | "unknown";

/**
 * Base stream message structure.
 */
export interface StreamMessageBase {
  type: StreamMessageType;
}

/**
 * Assistant text message.
 */
export interface AssistantMessage extends StreamMessageBase {
  type: "assistant";
  message: {
    type: string;
    content?: string;
    text?: string;
  };
}

/**
 * Tool use message.
 */
export interface ToolUseMessage extends StreamMessageBase {
  type: "tool_use";
  tool?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Tool result message.
 */
export interface ToolResultMessage extends StreamMessageBase {
  type: "tool_result";
  tool?: string;
  name?: string;
  result?: unknown;
  output?: string;
}

/**
 * Final result message.
 */
export interface ResultMessage extends StreamMessageBase {
  type: "result";
  subtype?: "success" | "error";
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  duration_ms?: number;
  session_id?: string;
}

/**
 * System message.
 */
export interface SystemMessage extends StreamMessageBase {
  type: "system";
  subtype?: string;
  event?: string;
  data?: unknown;
}

/**
 * Error message.
 */
export interface ErrorMessage extends StreamMessageBase {
  type: "error";
  error: string;
}

/**
 * Union of all stream message types.
 */
export type StreamMessage =
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | ResultMessage
  | SystemMessage
  | ErrorMessage;

/**
 * Parsed output message for Redis publishing.
 */
export interface OutputPayload {
  type: "output" | "result" | "error";
  session_id: string;
  timestamp: string;
  data: FormattedMessage | ResultData | ErrorData;
}

/**
 * Formatted message for client consumption.
 */
export interface FormattedMessage {
  type: StreamMessageType;
  message?: unknown;
  tool?: string;
  input?: unknown;
  result?: unknown;
  event?: string;
  data?: unknown;
}

/**
 * Result data structure.
 */
export interface ResultData {
  subtype: string;
  result: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  duration_ms?: number;
}

/**
 * Error data structure.
 */
export interface ErrorData {
  error: string;
}

/**
 * Input message pushed to session queue.
 */
export interface InputMessage {
  prompt: string;
  images?: ImageInput[];
  context?: Record<string, unknown>;
}

/**
 * Image input for Claude.
 */
export interface ImageInput {
  /** Base64 encoded image data */
  data?: string;
  /** File path to image */
  path?: string;
  /** MIME type */
  mimeType?: string;
  /** URL to image */
  url?: string;
}

/**
 * Interrupt message for session control.
 */
export interface InterruptMessage {
  type: "stop" | "redirect" | "pause";
  message?: string;
  priority?: "normal" | "high";
}

/**
 * Claude Code run result.
 */
export interface ClaudeRunResult {
  result: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  duration_ms: number;
  exit_code: number;
  claudeSessionId?: string;
}

/**
 * Container create options.
 */
export interface ContainerCreateOptions {
  sessionKey: string;
  agentId?: string;
  workspaceDir: string;
  config: DockerCCPoolConfig;
  claudeConfig?: ClaudeContainerConfig;
}

/**
 * Claude configuration passed to container.
 */
export interface ClaudeContainerConfig {
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: "bypassPermissions" | "prompt" | "strict";
  verbose?: boolean;
}

/**
 * MCP server configuration.
 */
export interface McpServerConfig {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/**
 * Pool manager state.
 */
export interface PoolState {
  /** Active containers by container name */
  containers: Map<string, ContainerRegistryEntry>;
  /** Session key to container name mapping */
  sessionToContainer: Map<string, string>;
  /** Warm (unassigned) container names */
  warmPool: Set<string>;
}

/**
 * Container assignment result.
 */
export interface ContainerAssignment {
  containerName: string;
  containerId: string;
  isNew: boolean;
  wasWarm: boolean;
}

/**
 * Provider run options (passed from Clawdbot agent runner).
 */
export interface DockerCCRunOptions {
  sessionKey: string;
  agentId?: string;
  prompt: string;
  images?: ImageInput[];
  workspaceDir: string;
  extraSystemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  onOutput?: (msg: FormattedMessage) => void | Promise<void>;
  onResult?: (result: ClaudeRunResult) => void | Promise<void>;
}

/**
 * Docker CC provider interface.
 */
export interface DockerCCProvider {
  /** Check if provider is available and healthy */
  isAvailable(): Promise<boolean>;
  /** Run a prompt through Docker Claude Code */
  run(options: DockerCCRunOptions): Promise<ClaudeRunResult>;
  /** Stop a session */
  stop(sessionKey: string): Promise<void>;
  /** Get session status */
  getStatus(sessionKey: string): Promise<ContainerHealthStatus | null>;
  /** Send interrupt to session */
  sendInterrupt(sessionKey: string, interrupt: InterruptMessage): Promise<void>;
  /** Shutdown provider and cleanup */
  shutdown(): Promise<void>;
}
