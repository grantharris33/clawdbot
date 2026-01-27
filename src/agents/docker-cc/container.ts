/**
 * Docker container management for Docker CC.
 *
 * This module handles creating, starting, stopping, and managing
 * Docker containers running Claude Code CLI.
 */

import { spawn } from "node:child_process";
import type {
  ContainerCreateOptions,
  ContainerRegistryEntry,
  DockerCCPoolConfig,
} from "./types.js";
import {
  generateConfigHash,
  generateContainerLabels,
  generateContainerName,
  getContainerEnv,
  parseContainerLabels,
  resolveRedisUrl,
} from "./config.js";

/**
 * Execute a docker command and return the result.
 */
export function execDocker(
  args: string[],
  opts?: { allowFailure?: boolean; timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts?.timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        reject(new Error(stderr.trim() || `docker ${args.join(" ")} failed`));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    child.on("error", (err) => {
      if (opts?.allowFailure) {
        resolve({ stdout, stderr, code: 1 });
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Check if a Docker image exists locally.
 */
export async function dockerImageExists(image: string): Promise<boolean> {
  const result = await execDocker(["image", "inspect", image], { allowFailure: true });
  if (result.code === 0) return true;
  const stderr = result.stderr.trim();
  if (stderr.includes("No such image")) {
    return false;
  }
  throw new Error(`Failed to inspect Docker CC image: ${stderr}`);
}

/**
 * Pull a Docker image.
 */
export async function pullDockerImage(image: string): Promise<void> {
  await execDocker(["pull", image]);
}

/**
 * Ensure Docker image exists, pull if not.
 */
export async function ensureDockerImage(image: string): Promise<void> {
  const exists = await dockerImageExists(image);
  if (!exists) {
    await pullDockerImage(image);
  }
}

/**
 * Get container state (exists, running).
 */
export async function getContainerState(
  name: string,
): Promise<{ exists: boolean; running: boolean }> {
  const result = await execDocker(["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) return { exists: false, running: false };
  return { exists: true, running: result.stdout.trim() === "true" };
}

/**
 * Get container ID from name.
 */
export async function getContainerId(name: string): Promise<string | null> {
  const result = await execDocker(["inspect", "-f", "{{.Id}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Get container labels.
 */
export async function getContainerLabels(name: string): Promise<Record<string, string> | null> {
  const result = await execDocker(["inspect", "-f", "{{json .Config.Labels}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) return null;

  try {
    return JSON.parse(result.stdout.trim()) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Build docker create arguments for a Docker CC container.
 */
export function buildContainerCreateArgs(options: ContainerCreateOptions): string[] {
  const { sessionKey, agentId, workspaceDir, config, claudeConfig } = options;
  const containerName = generateContainerName(sessionKey, config);
  const labels = generateContainerLabels({ sessionKey, agentId, config });

  const args = ["create", "--name", containerName];

  // Labels
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined) {
      args.push("--label", `${String(key)}=${String(value)}`);
    }
  }

  // Resource limits
  if (config.resources.memory) {
    args.push("--memory", config.resources.memory);
  }
  if (config.resources.cpus > 0) {
    args.push("--cpus", config.resources.cpus.toString());
  }
  if (config.resources.pidsLimit > 0) {
    args.push("--pids-limit", config.resources.pidsLimit.toString());
  }

  // Network
  if (config.docker.network) {
    args.push("--network", config.docker.network);
  }

  // Security options
  for (const cap of config.docker.capDrop) {
    args.push("--cap-drop", cap);
  }
  for (const opt of config.docker.securityOpts) {
    args.push("--security-opt", opt);
  }

  // Workspace bind mount
  args.push("-v", `${workspaceDir}:/workspace`);

  // Additional binds
  if (config.docker.binds) {
    for (const bind of config.docker.binds) {
      args.push("-v", bind);
    }
  }

  // Working directory
  args.push("--workdir", "/workspace");

  // Environment variables
  const redisUrl = resolveRedisUrl(config);
  const env = getContainerEnv({
    sessionKey,
    redisUrl,
    gatewayUrl: config.docker.env?.GATEWAY_URL,
    workspacePath: "/workspace",
    claudeModel: claudeConfig?.model,
    claudeConfigJson: claudeConfig ? JSON.stringify(claudeConfig) : undefined,
  });

  // Merge with custom env
  const finalEnv = { ...env, ...config.docker.env };
  for (const [key, value] of Object.entries(finalEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  // Image
  args.push(config.image);

  return args;
}

/**
 * Create a Docker CC container.
 */
export async function createContainer(options: ContainerCreateOptions): Promise<{
  containerName: string;
  containerId: string;
}> {
  const containerName = generateContainerName(options.sessionKey, options.config);

  // Ensure image exists
  await ensureDockerImage(options.config.image);

  // Build create arguments
  const createArgs = buildContainerCreateArgs(options);

  // Create container
  await execDocker(createArgs);

  // Get container ID
  const containerId = await getContainerId(containerName);
  if (!containerId) {
    throw new Error(`Failed to get container ID for ${containerName}`);
  }

  return { containerName, containerId };
}

/**
 * Start a container.
 */
export async function startContainer(name: string): Promise<void> {
  await execDocker(["start", name]);
}

/**
 * Stop a container.
 */
export async function stopContainer(name: string, timeout = 10): Promise<void> {
  await execDocker(["stop", "-t", timeout.toString(), name], { allowFailure: true });
}

/**
 * Remove a container.
 */
export async function removeContainer(name: string, force = true): Promise<void> {
  const args = ["rm"];
  if (force) args.push("-f");
  args.push(name);
  await execDocker(args, { allowFailure: true });
}

/**
 * Execute a command in a container.
 */
export async function execInContainer(
  name: string,
  command: string[],
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const args = ["exec", "-i", name, ...command];
  return execDocker(args, { allowFailure: true, timeout: opts?.timeout });
}

/**
 * List all Docker CC containers.
 */
export async function listContainers(): Promise<ContainerRegistryEntry[]> {
  const result = await execDocker(
    ["ps", "-a", "--filter", "label=clawdbot.docker-cc=1", "--format", "{{json .}}"],
    { allowFailure: true },
  );

  if (result.code !== 0) return [];

  const containers: ContainerRegistryEntry[] = [];
  const lines = result.stdout.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const data = JSON.parse(line) as {
        ID: string;
        Names: string;
        Labels: string;
        State: string;
      };

      // Parse labels from the Labels field (format: "key=value,key=value")
      const labelsMap: Record<string, string> = {};
      if (data.Labels) {
        const pairs = data.Labels.split(",");
        for (const pair of pairs) {
          const [key, ...valueParts] = pair.split("=");
          if (key) {
            labelsMap[key] = valueParts.join("=");
          }
        }
      }

      const parsed = parseContainerLabels(labelsMap);
      if (!parsed.isDockerCC || !parsed.sessionKey) continue;

      const isRunning = data.State === "running";

      containers.push({
        containerId: data.ID,
        containerName: data.Names,
        sessionKey: parsed.sessionKey,
        agentId: parsed.agentId,
        status: isRunning ? "running" : "stopped",
        createdAt: parsed.createdAtMs ?? Date.now(),
        lastHeartbeat: Date.now(),
        turnCount: 0,
        configHash: parsed.configHash ?? "",
      });
    } catch {
      // Skip invalid JSON lines
    }
  }

  return containers;
}

/**
 * Check if a container exists and matches the expected config.
 */
export async function checkContainerConfig(
  name: string,
  config: DockerCCPoolConfig,
): Promise<{ exists: boolean; configMatch: boolean; running: boolean }> {
  const state = await getContainerState(name);
  if (!state.exists) {
    return { exists: false, configMatch: false, running: false };
  }

  const labels = await getContainerLabels(name);
  if (!labels) {
    return { exists: true, configMatch: false, running: state.running };
  }

  const currentHash = labels["clawdbot.configHash"];
  const expectedHash = generateConfigHash(config);

  return {
    exists: true,
    configMatch: currentHash === expectedHash,
    running: state.running,
  };
}

/**
 * Wait for container to be ready by polling a health check function.
 *
 * @param name - Container name (for logging)
 * @param timeoutMs - Maximum time to wait
 * @param checkFn - Function that returns true when container is ready
 * @param pollIntervalMs - How often to poll (default 250ms)
 * @returns true if container became ready, false if timeout reached
 */
export async function waitForContainerReady(
  name: string,
  timeoutMs: number,
  checkFn: () => Promise<boolean>,
  pollIntervalMs = 250,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const ready = await checkFn();
      if (ready) {
        return true;
      }
    } catch (err) {
      // Check function failed, container not ready yet
      console.debug(`Container ${name} health check failed: ${String(err)}`);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.warn(`Container ${name} did not become ready within ${timeoutMs}ms`);
  return false;
}

/**
 * Get container logs.
 */
export async function getContainerLogs(
  name: string,
  opts?: { tail?: number; since?: string },
): Promise<string> {
  const args = ["logs"];
  if (opts?.tail) {
    args.push("--tail", opts.tail.toString());
  }
  if (opts?.since) {
    args.push("--since", opts.since);
  }
  args.push(name);

  const result = await execDocker(args, { allowFailure: true });
  return result.stdout + result.stderr;
}

/**
 * Check if Docker daemon is available.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await execDocker(["info"], { allowFailure: true, timeout: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Create and start a container in one operation.
 */
export async function createAndStartContainer(options: ContainerCreateOptions): Promise<{
  containerName: string;
  containerId: string;
}> {
  const result = await createContainer(options);
  await startContainer(result.containerName);
  return result;
}

/**
 * Ensure a container exists and is running for a session.
 */
export async function ensureContainer(options: ContainerCreateOptions): Promise<{
  containerName: string;
  containerId: string;
  wasCreated: boolean;
}> {
  const containerName = generateContainerName(options.sessionKey, options.config);

  // Check if container exists and matches config
  const check = await checkContainerConfig(containerName, options.config);

  if (check.exists && check.configMatch) {
    // Container exists with matching config
    if (!check.running) {
      await startContainer(containerName);
    }
    const containerId = await getContainerId(containerName);
    return {
      containerName,
      containerId: containerId ?? "",
      wasCreated: false,
    };
  }

  if (check.exists && !check.configMatch) {
    // Container exists but config doesn't match - remove and recreate
    await removeContainer(containerName);
  }

  // Create new container
  const result = await createAndStartContainer(options);
  return {
    ...result,
    wasCreated: true,
  };
}
