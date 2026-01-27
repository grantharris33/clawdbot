/**
 * Container registry for Docker CC.
 *
 * Persists container metadata to disk for recovery after gateway restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ContainerRegistryEntry } from "./types.js";

/**
 * Registry file location.
 */
const REGISTRY_DIR = ".clawdbot/docker-cc";
const REGISTRY_FILE = "containers.json";

/**
 * Registry data structure.
 */
interface RegistryData {
  version: number;
  entries: ContainerRegistryEntry[];
}

/**
 * Current registry version.
 */
const REGISTRY_VERSION = 1;

/**
 * Get the registry file path.
 */
function getRegistryPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, REGISTRY_DIR, REGISTRY_FILE);
}

/**
 * Ensure registry directory exists.
 */
async function ensureRegistryDir(): Promise<void> {
  const registryPath = getRegistryPath();
  const dir = path.dirname(registryPath);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read the container registry from disk.
 */
export async function readRegistry(): Promise<RegistryData> {
  const registryPath = getRegistryPath();

  try {
    const content = await fs.readFile(registryPath, "utf-8");
    const data = JSON.parse(content) as RegistryData;

    // Validate version
    if (data.version !== REGISTRY_VERSION) {
      // Future: handle migrations
      return { version: REGISTRY_VERSION, entries: [] };
    }

    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: REGISTRY_VERSION, entries: [] };
    }
    throw err;
  }
}

/**
 * Write the container registry to disk.
 */
export async function writeRegistry(data: RegistryData): Promise<void> {
  await ensureRegistryDir();
  const registryPath = getRegistryPath();
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(registryPath, content, "utf-8");
}

/**
 * Update a container entry in the registry.
 */
export async function updateContainerEntry(entry: ContainerRegistryEntry): Promise<void> {
  const registry = await readRegistry();

  // Find existing entry
  const index = registry.entries.findIndex((e) => e.containerName === entry.containerName);

  if (index >= 0) {
    registry.entries[index] = entry;
  } else {
    registry.entries.push(entry);
  }

  await writeRegistry(registry);
}

/**
 * Remove a container entry from the registry.
 */
export async function removeContainerEntry(containerName: string): Promise<void> {
  const registry = await readRegistry();
  registry.entries = registry.entries.filter((e) => e.containerName !== containerName);
  await writeRegistry(registry);
}

/**
 * Get a container entry by name.
 */
export async function getContainerEntry(
  containerName: string,
): Promise<ContainerRegistryEntry | null> {
  const registry = await readRegistry();
  return registry.entries.find((e) => e.containerName === containerName) ?? null;
}

/**
 * Get a container entry by session key.
 */
export async function getContainerBySessionKey(
  sessionKey: string,
): Promise<ContainerRegistryEntry | null> {
  const registry = await readRegistry();
  return registry.entries.find((e) => e.sessionKey === sessionKey) ?? null;
}

/**
 * List all container entries.
 */
export async function listContainerEntries(): Promise<ContainerRegistryEntry[]> {
  const registry = await readRegistry();
  return registry.entries;
}

/**
 * List container entries by agent ID.
 */
export async function listContainersByAgent(agentId: string): Promise<ContainerRegistryEntry[]> {
  const registry = await readRegistry();
  return registry.entries.filter((e) => e.agentId === agentId);
}

/**
 * List warm (unassigned) container entries.
 */
export async function listWarmContainers(): Promise<ContainerRegistryEntry[]> {
  const registry = await readRegistry();
  return registry.entries.filter((e) => e.sessionKey === null && e.status === "idle");
}

/**
 * Update container status.
 */
export async function updateContainerStatus(
  containerName: string,
  status: ContainerRegistryEntry["status"],
): Promise<void> {
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.containerName === containerName);

  if (entry) {
    entry.status = status;
    entry.lastHeartbeat = Date.now();
    await writeRegistry(registry);
  }
}

/**
 * Update container heartbeat.
 */
export async function updateContainerHeartbeat(
  containerName: string,
  claudeSessionId?: string,
  turnCount?: number,
): Promise<void> {
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.containerName === containerName);

  if (entry) {
    entry.lastHeartbeat = Date.now();
    if (claudeSessionId !== undefined) {
      entry.claudeSessionId = claudeSessionId;
    }
    if (turnCount !== undefined) {
      entry.turnCount = turnCount;
    }
    await writeRegistry(registry);
  }
}

/**
 * Assign a container to a session.
 */
export async function assignContainerToSession(
  containerName: string,
  sessionKey: string,
  agentId?: string,
): Promise<void> {
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.containerName === containerName);

  if (entry) {
    entry.sessionKey = sessionKey;
    entry.agentId = agentId;
    entry.lastHeartbeat = Date.now();
    await writeRegistry(registry);
  }
}

/**
 * Unassign a container from its session (return to warm pool).
 */
export async function unassignContainer(containerName: string): Promise<void> {
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.containerName === containerName);

  if (entry) {
    entry.sessionKey = null;
    entry.agentId = undefined;
    entry.claudeSessionId = undefined;
    entry.turnCount = 0;
    entry.status = "idle";
    entry.lastHeartbeat = Date.now();
    await writeRegistry(registry);
  }
}

/**
 * Get containers that are past their idle timeout.
 */
export async function getIdleContainers(idleTimeoutMs: number): Promise<ContainerRegistryEntry[]> {
  const registry = await readRegistry();
  const now = Date.now();

  return registry.entries.filter((e) => {
    if (e.status !== "idle") return false;
    return now - e.lastHeartbeat > idleTimeoutMs;
  });
}

/**
 * Get containers that are past their max age.
 */
export async function getExpiredContainers(maxAgeMs: number): Promise<ContainerRegistryEntry[]> {
  const registry = await readRegistry();
  const now = Date.now();

  return registry.entries.filter((e) => now - e.createdAt > maxAgeMs);
}

/**
 * Get containers with stale heartbeats (potentially dead).
 */
export async function getStaleContainers(
  staleThresholdMs: number,
): Promise<ContainerRegistryEntry[]> {
  const registry = await readRegistry();
  const now = Date.now();

  return registry.entries.filter((e) => {
    // Only check running containers
    if (e.status !== "running" && e.status !== "idle") return false;
    return now - e.lastHeartbeat > staleThresholdMs;
  });
}

/**
 * Sync registry with actual Docker state.
 * Removes entries for containers that no longer exist.
 */
export async function syncWithDocker(
  existingContainerNames: Set<string>,
): Promise<{ removed: string[] }> {
  const registry = await readRegistry();
  const removed: string[] = [];

  registry.entries = registry.entries.filter((e) => {
    if (existingContainerNames.has(e.containerName)) {
      return true;
    }
    removed.push(e.containerName);
    return false;
  });

  if (removed.length > 0) {
    await writeRegistry(registry);
  }

  return { removed };
}

/**
 * Clear all entries from the registry.
 */
export async function clearRegistry(): Promise<void> {
  await writeRegistry({ version: REGISTRY_VERSION, entries: [] });
}
