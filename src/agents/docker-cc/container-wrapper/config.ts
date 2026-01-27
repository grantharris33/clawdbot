/**
 * Wrapper configuration loading and Claude args generation.
 *
 * Port of CC-Docker config.py to TypeScript.
 */

import type { ClaudeConfig, WrapperConfig } from "./types.js";

/**
 * Load wrapper configuration from environment variables.
 */
export function loadConfigFromEnv(): WrapperConfig {
  const sessionId = process.env.SESSION_ID;
  if (!sessionId) {
    throw new Error("SESSION_ID environment variable is required");
  }

  // Parse Claude config from environment
  let claudeConfig: ClaudeConfig | undefined;
  const claudeConfigJson = process.env.CLAUDE_CONFIG;
  if (claudeConfigJson) {
    try {
      claudeConfig = JSON.parse(claudeConfigJson) as ClaudeConfig;
    } catch (e) {
      console.warn(`Warning: Failed to parse CLAUDE_CONFIG: ${String(e)}`);
    }
  }

  return {
    sessionId,
    redisUrl: process.env.REDIS_URL ?? "redis://redis:6379",
    gatewayUrl: process.env.GATEWAY_URL ?? "http://gateway:8000",
    parentSessionId: process.env.PARENT_SESSION_ID,
    workspacePath: process.env.WORKSPACE_PATH ?? "/workspace",
    claudeModel: process.env.CLAUDE_MODEL ?? "opus-4",
    claudeConfig,
  };
}

/**
 * Convert Claude config to CLI arguments.
 */
export function toClaudeArgs(config: ClaudeConfig): string[] {
  const args: string[] = [];

  // MCP servers
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    const mcpConfig = { mcpServers: config.mcpServers };
    args.push("--mcp-config", JSON.stringify(mcpConfig));
  }

  // Plugin directories
  if (config.pluginDirs) {
    for (const pluginDir of config.pluginDirs) {
      args.push("--plugin-dir", pluginDir);
    }
  }

  // Model
  if (config.model) {
    args.push("--model", config.model);
  }

  // Tools
  if (config.allowedTools && config.allowedTools.length > 0 && !config.allowedTools.includes("*")) {
    args.push("--allowed-tools", config.allowedTools.join(","));
  }

  if (config.disallowedTools && config.disallowedTools.length > 0) {
    args.push("--disallowed-tools", config.disallowedTools.join(","));
  }

  // System prompt
  if (config.systemPrompt) {
    args.push("--system-prompt", config.systemPrompt);
  }

  if (config.appendSystemPrompt) {
    args.push("--append-system-prompt", config.appendSystemPrompt);
  }

  // Agents
  if (config.customAgents && Object.keys(config.customAgents).length > 0) {
    args.push("--agents", JSON.stringify(config.customAgents));
  }

  // Skills
  if (config.skillsEnabled === false) {
    args.push("--disable-slash-commands");
  }

  // Permission mode
  if (config.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else if (config.permissionMode) {
    args.push("--permission-mode", config.permissionMode);
  }

  // Verbose
  if (config.verbose) {
    args.push("--verbose");
  }

  return args;
}

/**
 * Build full Claude CLI command arguments.
 */
export function buildClaudeCommand(params: {
  prompt: string;
  config?: ClaudeConfig;
  resume?: boolean;
  sessionId?: string;
}): string[] {
  const cmd = [
    "claude",
    "-p",
    params.prompt,
    "--output-format",
    "stream-json",
    "--verbose", // Required for stream-json with -p
  ];

  // Add config-based args
  if (params.config) {
    cmd.push(...toClaudeArgs(params.config));
  } else {
    // Default: bypass permissions
    cmd.push("--dangerously-skip-permissions");
  }

  // Resume session if available
  if (params.resume && params.sessionId) {
    cmd.push("--resume", params.sessionId);
  }

  return cmd;
}
