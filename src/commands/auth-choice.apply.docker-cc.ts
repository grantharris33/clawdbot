/**
 * Docker Claude Code auth choice handler.
 *
 * Handles the interactive setup of Docker Claude Code as a provider.
 * Docker CC runs Claude Code CLI in containers, using the subscription
 * token subsidy instead of API calls.
 *
 * This handler manages the full infrastructure setup:
 * - Docker availability check
 * - Redis container setup (if needed)
 * - Docker network creation
 * - Docker CC image pull
 */

import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import {
  applyDockerCCConfig,
  checkDockerAvailability,
  checkRedisAvailability,
  createDockerNetwork,
  pullDockerCCImage,
  startRedisContainer,
  DOCKER_CC_DEFAULT_IMAGE,
  DOCKER_CC_DEFAULT_NETWORK,
  DOCKER_CC_REDIS_CONTAINER_NAME,
} from "./onboard-auth.config-docker-cc.js";

export async function applyAuthChoiceDockerCC(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "docker-cc") {
    return null;
  }

  let nextConfig = params.config;
  const progress = params.prompter.progress("Checking Docker availability...");

  // Show information about Docker CC
  await params.prompter.note(
    [
      "Docker Claude Code runs the Claude Code CLI in isolated containers.",
      "This uses your Claude Pro/Team subscription instead of API costs.",
      "",
      "This setup will:",
      "  1. Verify Docker is installed and running",
      "  2. Start a Redis container (for container communication)",
      "  3. Create the Docker network",
      "  4. Pull the Docker CC image",
    ].join("\n"),
    "Docker Claude Code Setup",
  );

  // Step 1: Check Docker availability
  progress.update("Checking Docker availability...");
  const dockerCheck = await checkDockerAvailability();
  if (!dockerCheck.available) {
    progress.stop();
    await params.prompter.note(
      [
        "Docker is not available or not running.",
        dockerCheck.error ? `Error: ${dockerCheck.error}` : "",
        "",
        "Please install Docker Desktop and ensure it is running:",
        "  - macOS/Windows: https://www.docker.com/products/docker-desktop",
        "  - Linux: https://docs.docker.com/engine/install/",
        "",
        "After installing Docker, run this setup again.",
      ]
        .filter(Boolean)
        .join("\n"),
      "Docker Required",
    );
    return { config: nextConfig };
  }

  // Step 2: Check/Setup Redis
  progress.update("Checking Redis availability...");
  let redisUrl = "redis://localhost:6379";
  const redisCheck = await checkRedisAvailability(redisUrl);

  if (!redisCheck.available) {
    progress.stop();

    // Ask if user wants to start Redis via Docker
    const startRedis = await params.prompter.confirm({
      message: "Redis is not running. Start Redis container automatically?",
      initialValue: true,
    });

    if (startRedis) {
      progress.update("Creating Docker network...");

      // Create Docker network first
      const networkResult = await createDockerNetwork(DOCKER_CC_DEFAULT_NETWORK);
      if (!networkResult.success && !networkResult.alreadyExists) {
        progress.stop();
        await params.prompter.note(
          `Failed to create Docker network: ${networkResult.error}`,
          "Network Error",
        );
        return { config: nextConfig };
      }

      progress.update("Starting Redis container...");
      const redisResult = await startRedisContainer({
        containerName: DOCKER_CC_REDIS_CONTAINER_NAME,
        network: DOCKER_CC_DEFAULT_NETWORK,
        port: 6379,
      });

      if (!redisResult.success) {
        progress.stop();
        await params.prompter.note(
          [
            "Failed to start Redis container.",
            redisResult.error ? `Error: ${redisResult.error}` : "",
            "",
            "You can start Redis manually:",
            `  docker run -d --name ${DOCKER_CC_REDIS_CONTAINER_NAME} \\`,
            `    --network ${DOCKER_CC_DEFAULT_NETWORK} \\`,
            "    -p 6379:6379 redis:alpine",
          ]
            .filter(Boolean)
            .join("\n"),
          "Redis Setup Failed",
        );
        return { config: nextConfig };
      }

      // Verify Redis is now accessible
      progress.update("Verifying Redis connection...");
      await sleep(1000); // Give Redis a moment to start
      const verifyRedis = await checkRedisAvailability(redisUrl);
      if (!verifyRedis.available) {
        progress.stop();
        await params.prompter.note(
          [
            "Redis container started but connection failed.",
            "This may be a timing issue. The container is running and should be ready shortly.",
          ].join("\n"),
          "Redis Verification",
        );
      }
    } else {
      // User declined automatic Redis setup
      const useExternalRedis = await params.prompter.confirm({
        message: "Do you have an external Redis server to use?",
        initialValue: false,
      });

      if (useExternalRedis) {
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

        progress.update("Verifying Redis connection...");
        const externalRedisCheck = await checkRedisAvailability(redisUrl);
        if (!externalRedisCheck.available) {
          progress.stop();
          await params.prompter.note(
            [
              "Could not connect to the specified Redis server.",
              externalRedisCheck.error ? `Error: ${externalRedisCheck.error}` : "",
              "",
              "Please ensure Redis is running and accessible, then try again.",
            ]
              .filter(Boolean)
              .join("\n"),
            "Redis Connection Failed",
          );
          return { config: nextConfig };
        }
      } else {
        progress.stop();
        await params.prompter.note(
          [
            "Redis is required for Docker Claude Code.",
            "",
            "You can start Redis manually with Docker:",
            "  docker run -d --name clawdbot-redis -p 6379:6379 redis:alpine",
            "",
            "Then run this setup again.",
          ].join("\n"),
          "Redis Required",
        );
        return { config: nextConfig };
      }
    }
  } else {
    // Redis is already running
    progress.stop();
    await params.prompter.note(`Redis is available at ${redisUrl}`, "Redis Found");
  }

  // Step 3: Ensure Docker network exists
  progress.update("Setting up Docker network...");
  const networkResult = await createDockerNetwork(DOCKER_CC_DEFAULT_NETWORK);
  if (!networkResult.success && !networkResult.alreadyExists) {
    progress.stop();
    await params.prompter.note(
      `Warning: Could not create Docker network: ${networkResult.error}`,
      "Network Warning",
    );
  }

  // Step 4: Pull Docker CC image
  progress.stop();
  const pullImage = await params.prompter.confirm({
    message: `Pull Docker CC image (${DOCKER_CC_DEFAULT_IMAGE})? This may take a few minutes.`,
    initialValue: true,
  });

  if (pullImage) {
    progress.update(`Pulling ${DOCKER_CC_DEFAULT_IMAGE}...`);
    const pullResult = await pullDockerCCImage(DOCKER_CC_DEFAULT_IMAGE);
    progress.stop();

    if (!pullResult.success) {
      await params.prompter.note(
        [
          "Could not pull Docker CC image.",
          pullResult.error ? `Error: ${pullResult.error}` : "",
          "",
          "The image will be pulled automatically when first used,",
          "or you can build it manually:",
          "  cd src/agents/docker-cc && docker build -t clawdbot/docker-cc:latest .",
        ]
          .filter(Boolean)
          .join("\n"),
        "Image Pull Warning",
      );
    } else {
      await params.prompter.note("Docker CC image is ready.", "Image Ready");
    }
  }

  // Step 5: Configure pool settings
  const configurePool = await params.prompter.confirm({
    message: "Configure container pool settings? (default: min 0 warm, max 10 total)",
    initialValue: false,
  });

  let poolMinWarm = 0;
  let poolMaxTotal = 10;
  if (configurePool) {
    const minWarmInput = await params.prompter.text({
      message: "Minimum warm containers (pre-started for faster response)",
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

  await params.prompter.note(
    [
      "Docker Claude Code setup complete!",
      "",
      "Configuration:",
      `  - Redis: ${redisUrl}`,
      `  - Network: ${DOCKER_CC_DEFAULT_NETWORK}`,
      `  - Pool: ${poolMinWarm} warm, ${poolMaxTotal} max`,
      "",
      "Claude Code will run in Docker containers using your subscription.",
    ].join("\n"),
    "Setup Complete",
  );

  return { config: nextConfig };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
