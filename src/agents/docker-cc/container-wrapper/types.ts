/**
 * Type definitions for the container wrapper.
 *
 * These types are used within the Docker container by the wrapper process.
 */

/**
 * Wrapper configuration loaded from environment.
 */
export interface WrapperConfig {
  sessionId: string;
  redisUrl: string;
  gatewayUrl: string;
  parentSessionId?: string;
  workspacePath: string;
  claudeModel: string;
  claudeConfig?: ClaudeConfig;
}

/**
 * Claude Code configuration.
 */
export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>;
  pluginDirs?: string[];
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  customAgents?: Record<string, unknown>;
  skillsEnabled?: boolean;
  verbose?: boolean;
  permissionMode?: "bypassPermissions" | "prompt" | "strict";
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
 * Input message from parent.
 */
export interface InputMessage {
  prompt: string;
  images?: ImageInput[];
  context?: Record<string, unknown>;
}

/**
 * Image input.
 */
export interface ImageInput {
  data?: string;
  path?: string;
  mimeType?: string;
  url?: string;
}

/**
 * Interrupt message types.
 */
export interface InterruptMessage {
  type: "stop" | "redirect" | "pause" | "resume";
  message?: string;
  priority?: "normal" | "high";
}

/**
 * Claude run result.
 */
export interface ClaudeResult {
  result: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  durationMs: number;
  exitCode: number;
  sessionId?: string;
}

/**
 * Wrapper state values.
 */
export type WrapperState =
  | "starting"
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

/**
 * Output payload for Redis publishing.
 */
export interface OutputPayload {
  type: "output" | "result" | "error";
  session_id: string;
  timestamp: string;
  data: unknown;
}

/**
 * Result payload data.
 */
export interface ResultPayloadData {
  subtype: "success" | "error";
  result: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  duration_ms?: number;
}

/**
 * Logger interface.
 */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
