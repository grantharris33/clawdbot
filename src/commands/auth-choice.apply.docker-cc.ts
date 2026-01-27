/**
 * Docker Claude Code auth choice handler.
 *
 * Handles the interactive setup of Docker Claude Code as a provider.
 * Docker CC runs Claude Code CLI in containers, using the subscription
 * token subsidy instead of API calls.
 */

import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDockerCCConfig, checkDockerAvailability } from "./onboard-auth.config-docker-cc.js";

export async function applyAuthChoiceDockerCC(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "docker-cc") {
    return null;
  }

  let nextConfig = params.config;

  // Show information about Docker CC
  await params.prompter.note(
    [
      "Docker Claude Code runs the Claude Code CLI in isolated containers.",
      "This uses your Claude Pro/Team subscription instead of API costs.",
      "",
      "Requirements:",
      "  - Docker installed and running",
      "  - Redis (optional, for advanced features)",
      "",
      "The container pool will be managed automatically.",
    ].join("\n"),
    "Docker Claude Code",
  );

  // Check Docker availability
  const dockerCheck = await checkDockerAvailability();
  if (!dockerCheck.available) {
    await params.prompter.note(
      [
        "Docker is not available or not running.",
        dockerCheck.error ? `Error: ${dockerCheck.error}` : "",
        "",
        "Please install Docker and ensure it is running, then try again.",
        "You can still configure Docker CC and start it later.",
      ]
        .filter(Boolean)
        .join("\n"),
      "Docker not available",
    );

    const continueAnyway = await params.prompter.confirm({
      message: "Continue with Docker CC setup anyway?",
      initialValue: false,
    });

    if (!continueAnyway) {
      return { config: nextConfig };
    }
  }

  // Ask about Redis configuration
  const useCustomRedis = await params.prompter.confirm({
    message: "Configure custom Redis URL? (default: redis://localhost:6379)",
    initialValue: false,
  });

  let redisUrl: string | undefined;
  if (useCustomRedis) {
    redisUrl = await params.prompter.text({
      message: "Enter Redis URL",
      placeholder: "redis://localhost:6379",
      validate: (value) => {
        if (!value?.trim()) return "Redis URL is required";
        if (!value.startsWith("redis://") && !value.startsWith("rediss://")) {
          return "Redis URL must start with redis:// or rediss://";
        }
        return undefined;
      },
    });
  }

  // Ask about pool configuration
  const configurePool = await params.prompter.confirm({
    message: "Configure container pool settings? (default: min 0, max 10)",
    initialValue: false,
  });

  let poolMinWarm = 0;
  let poolMaxTotal = 10;
  if (configurePool) {
    const minWarmInput = await params.prompter.text({
      message: "Minimum warm containers (pre-started, faster response)",
      placeholder: "0",
      validate: (value) => {
        const num = Number.parseInt(value || "0", 10);
        if (Number.isNaN(num) || num < 0) return "Must be a non-negative number";
        return undefined;
      },
    });
    poolMinWarm = Number.parseInt(minWarmInput || "0", 10);

    const maxTotalInput = await params.prompter.text({
      message: "Maximum total containers",
      placeholder: "10",
      validate: (value) => {
        const num = Number.parseInt(value || "10", 10);
        if (Number.isNaN(num) || num < 1) return "Must be at least 1";
        return undefined;
      },
    });
    poolMaxTotal = Number.parseInt(maxTotalInput || "10", 10);
  }

  // Apply Docker CC configuration
  nextConfig = applyDockerCCConfig(nextConfig, {
    enabled: true,
    redisUrl,
    pool: {
      minWarm: poolMinWarm,
      maxTotal: poolMaxTotal,
    },
  });

  if (params.setDefaultModel) {
    await params.prompter.note(
      [
        "Docker Claude Code has been configured as your default provider.",
        "Claude Code will run in Docker containers using your subscription.",
        "",
        dockerCheck.available
          ? "Docker is available and ready to use."
          : "Note: Docker is not currently available. Start Docker before using.",
      ].join("\n"),
      "Configuration complete",
    );
  }

  return { config: nextConfig };
}
