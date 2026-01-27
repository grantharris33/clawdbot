/**
 * Docker Claude Code agent runner.
 *
 * This module provides integration between the Clawdbot agent system and
 * the Docker Claude Code provider. It wraps the Docker CC runner to provide
 * the same interface as the CLI and embedded Pi runners.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import type { MoltbotConfig } from "../config/config.js";
import type { AgentStreamParams } from "../commands/agent/types.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";
import {
  createDockerCCRunner,
  isDockerCCAvailable,
  type DockerCCRunOptions,
  type FormattedMessage,
} from "./docker-cc/index.js";
import { resolveDockerCCConfig } from "./docker-cc/config.js";

/**
 * Parameters for running a Docker CC agent.
 */
export interface DockerCCAgentParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: MoltbotConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: string;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  images?: ImageContent[];
  streamParams?: AgentStreamParams;
}

/**
 * Check if Docker CC is available for use.
 */
export async function checkDockerCCAvailable(cfg?: MoltbotConfig): Promise<boolean> {
  const dockerCCConfig = cfg?.agents?.defaults?.dockerClaudeCode;
  if (!dockerCCConfig?.enabled) {
    return false;
  }

  try {
    // Resolve config merging with defaults
    const resolvedConfig = resolveDockerCCConfig({
      enabled: true,
      pool: dockerCCConfig.pool,
      image: dockerCCConfig.image,
      resources: dockerCCConfig.resources,
      timeouts: dockerCCConfig.timeouts,
      redis: dockerCCConfig.redis,
      docker: dockerCCConfig.docker,
    });
    return await isDockerCCAvailable(resolvedConfig);
  } catch {
    return false;
  }
}

/**
 * Run an agent using Docker Claude Code.
 *
 * This function wraps the Docker CC provider to match the interface
 * expected by the Clawdbot agent system.
 */
export async function runDockerCCAgent(params: DockerCCAgentParams): Promise<EmbeddedPiRunResult> {
  const {
    sessionId,
    sessionKey,
    workspaceDir,
    config,
    prompt,
    model,
    timeoutMs,
    extraSystemPrompt,
    images,
  } = params;

  // Get Docker CC configuration from Clawdbot config and merge with defaults
  const dockerCCConfig = config?.agents?.defaults?.dockerClaudeCode;
  const resolvedConfig = resolveDockerCCConfig({
    enabled: true,
    pool: dockerCCConfig?.pool,
    image: dockerCCConfig?.image,
    resources: dockerCCConfig?.resources,
    timeouts: dockerCCConfig?.timeouts,
    redis: dockerCCConfig?.redis,
    docker: dockerCCConfig?.docker,
  });

  // Create runner
  const runner = createDockerCCRunner(resolvedConfig);

  // Collect output messages for result
  const outputMessages: FormattedMessage[] = [];
  let finalText = "";

  // Build run options
  const runOptions: DockerCCRunOptions = {
    sessionKey: sessionKey ?? sessionId,
    workspaceDir,
    prompt,
    model,
    extraSystemPrompt,
    timeoutMs,
    images: images?.map((img) => ({
      data: img.data,
      mimeType: img.mimeType,
    })),
    onOutput: async (msg) => {
      outputMessages.push(msg);

      // Accumulate assistant text for final result
      if (msg.type === "assistant") {
        const content = (msg.message as { content?: string })?.content;
        if (content) {
          finalText += content;
        }
      }
    },
  };

  try {
    const result = await runner.run(runOptions);

    // Build result payloads
    const payloads: EmbeddedPiRunResult["payloads"] = [];

    if (finalText || result.result) {
      payloads.push({
        text: finalText || result.result || "",
      });
    }

    return {
      payloads,
      meta: {
        durationMs: result.duration_ms,
        agentMeta: {
          sessionId: sessionKey ?? sessionId,
          provider: "docker-claude-code",
          model: model ?? "opus",
          usage: {
            input: result.usage.input_tokens,
            output: result.usage.output_tokens,
          },
        },
      },
    };
  } catch (err) {
    // Return error as result
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      payloads: [{ text: `Error: ${errorMsg}`, isError: true }],
      meta: {
        durationMs: 0,
        agentMeta: {
          sessionId: sessionKey ?? sessionId,
          provider: "docker-claude-code",
          model: model ?? "opus",
        },
        error: {
          kind: "context_overflow" as const,
          message: errorMsg,
        },
      },
    };
  }
}

/**
 * Shutdown the Docker CC runner (cleanup containers).
 */
export async function shutdownDockerCC(): Promise<void> {
  const { resetSharedRunner } = await import("./docker-cc/runner.js");
  await resetSharedRunner();
}
