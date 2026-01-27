/**
 * Container pool manager for Docker CC.
 *
 * Manages a pool of Docker containers running Claude Code, including:
 * - Creating and maintaining warm containers
 * - Assigning containers to sessions
 * - Health monitoring and cleanup
 * - Scaling based on demand
 */

import type {
  ContainerAssignment,
  ContainerCreateOptions,
  ContainerRegistryEntry,
  DockerCCPoolConfig,
  PoolState,
} from "./types.js";
import {
  createAndStartContainer,
  getContainerState,
  isDockerAvailable,
  listContainers,
  removeContainer,
  stopContainer,
} from "./container.js";
import {
  assignContainerToSession,
  getContainerBySessionKey,
  getExpiredContainers,
  getIdleContainers,
  getStaleContainers,
  listContainerEntries,
  listContainersByAgent,
  listWarmContainers,
  removeContainerEntry,
  syncWithDocker,
  unassignContainer,
  updateContainerEntry,
  updateContainerStatus,
} from "./registry.js";

/**
 * Pool manager for Docker CC containers.
 */
export class DockerCCPoolManager {
  private config: DockerCCPoolConfig;
  private state: PoolState;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(config: DockerCCPoolConfig) {
    this.config = config;
    this.state = {
      containers: new Map(),
      sessionToContainer: new Map(),
      warmPool: new Set(),
    };
  }

  /**
   * Start the pool manager.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // Check Docker availability
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      throw new Error("Docker is not available");
    }

    // Load existing containers from registry and sync with Docker
    await this.syncState();

    // Start health check interval
    this.healthCheckInterval = setInterval(
      () => void this.checkHealth(),
      this.config.timeouts.healthIntervalMs,
    );

    // Start maintenance interval (cleanup idle containers)
    this.maintenanceInterval = setInterval(
      () => void this.maintenance(),
      60 * 1000, // Every minute
    );

    this.isRunning = true;

    // Ensure minimum warm pool
    await this.ensureWarmPool();
  }

  /**
   * Stop the pool manager.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Stop intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
  }

  /**
   * Get a container for a session.
   * Returns an existing container if one is assigned, or assigns a warm one,
   * or creates a new one.
   */
  async getContainer(params: {
    sessionKey: string;
    agentId?: string;
    workspaceDir: string;
    claudeConfig?: ContainerCreateOptions["claudeConfig"];
  }): Promise<ContainerAssignment> {
    // Check if session already has a container
    const existingName = this.state.sessionToContainer.get(params.sessionKey);
    if (existingName) {
      const entry = this.state.containers.get(existingName);
      if (entry) {
        return {
          containerName: existingName,
          containerId: entry.containerId,
          isNew: false,
          wasWarm: false,
        };
      }
    }

    // Check registry for existing assignment
    const registryEntry = await getContainerBySessionKey(params.sessionKey);
    if (registryEntry) {
      const state = await getContainerState(registryEntry.containerName);
      if (state.exists && state.running) {
        this.state.containers.set(registryEntry.containerName, registryEntry);
        this.state.sessionToContainer.set(params.sessionKey, registryEntry.containerName);
        return {
          containerName: registryEntry.containerName,
          containerId: registryEntry.containerId,
          isNew: false,
          wasWarm: false,
        };
      }
    }

    // Check limits
    const agentContainers = await listContainersByAgent(params.agentId ?? "");
    if (agentContainers.length >= this.config.pool.maxPerAgent) {
      throw new Error(`Max containers per agent (${this.config.pool.maxPerAgent}) reached`);
    }

    const allContainers = await listContainerEntries();
    if (allContainers.length >= this.config.pool.maxTotal) {
      throw new Error(`Max total containers (${this.config.pool.maxTotal}) reached`);
    }

    // Try to get a warm container
    const warmContainers = await listWarmContainers();
    if (warmContainers.length > 0) {
      const warm = warmContainers[0];
      if (warm) {
        await assignContainerToSession(warm.containerName, params.sessionKey, params.agentId);
        this.state.warmPool.delete(warm.containerName);
        this.state.sessionToContainer.set(params.sessionKey, warm.containerName);
        this.state.containers.set(warm.containerName, {
          ...warm,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        });

        // Maintain warm pool in background
        void this.ensureWarmPool();

        return {
          containerName: warm.containerName,
          containerId: warm.containerId,
          isNew: false,
          wasWarm: true,
        };
      }
    }

    // Create new container
    const options: ContainerCreateOptions = {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      config: this.config,
      claudeConfig: params.claudeConfig,
    };

    const result = await createAndStartContainer(options);

    const entry: ContainerRegistryEntry = {
      containerId: result.containerId,
      containerName: result.containerName,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      status: "idle",
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      turnCount: 0,
      configHash: "",
    };

    await updateContainerEntry(entry);
    this.state.containers.set(result.containerName, entry);
    this.state.sessionToContainer.set(params.sessionKey, result.containerName);

    return {
      containerName: result.containerName,
      containerId: result.containerId,
      isNew: true,
      wasWarm: false,
    };
  }

  /**
   * Release a container from a session.
   * Container is stopped and removed, or returned to warm pool.
   */
  async releaseContainer(sessionKey: string, opts?: { returnToPool?: boolean }): Promise<void> {
    const containerName = this.state.sessionToContainer.get(sessionKey);
    if (!containerName) return;

    this.state.sessionToContainer.delete(sessionKey);

    if (opts?.returnToPool && this.state.warmPool.size < this.config.pool.minWarm) {
      // Return to warm pool
      await unassignContainer(containerName);
      this.state.warmPool.add(containerName);
      const entry = this.state.containers.get(containerName);
      if (entry) {
        entry.sessionKey = null;
        entry.agentId = undefined;
        entry.status = "idle";
      }
    } else {
      // Stop and remove
      await stopContainer(containerName);
      await removeContainer(containerName);
      await removeContainerEntry(containerName);
      this.state.containers.delete(containerName);
    }
  }

  /**
   * Stop and remove a container by name.
   */
  async removeContainerByName(containerName: string): Promise<void> {
    const entry = this.state.containers.get(containerName);
    if (entry?.sessionKey) {
      this.state.sessionToContainer.delete(entry.sessionKey);
    }
    this.state.warmPool.delete(containerName);
    this.state.containers.delete(containerName);

    await stopContainer(containerName);
    await removeContainer(containerName);
    await removeContainerEntry(containerName);
  }

  /**
   * Get pool statistics.
   */
  getStats(): {
    total: number;
    active: number;
    warm: number;
    maxTotal: number;
    maxPerAgent: number;
  } {
    return {
      total: this.state.containers.size,
      active: this.state.sessionToContainer.size,
      warm: this.state.warmPool.size,
      maxTotal: this.config.pool.maxTotal,
      maxPerAgent: this.config.pool.maxPerAgent,
    };
  }

  /**
   * Sync internal state with Docker and registry.
   */
  private async syncState(): Promise<void> {
    // Get actual containers from Docker
    const dockerContainers = await listContainers();
    const dockerNames = new Set(dockerContainers.map((c) => c.containerName));

    // Sync registry with Docker (remove stale entries)
    await syncWithDocker(dockerNames);

    // Load registry entries
    const registryEntries = await listContainerEntries();

    // Rebuild internal state
    this.state.containers.clear();
    this.state.sessionToContainer.clear();
    this.state.warmPool.clear();

    for (const entry of registryEntries) {
      this.state.containers.set(entry.containerName, entry);

      if (entry.sessionKey) {
        this.state.sessionToContainer.set(entry.sessionKey, entry.containerName);
      } else if (entry.status === "idle") {
        this.state.warmPool.add(entry.containerName);
      }
    }
  }

  /**
   * Ensure minimum warm pool size.
   */
  private async ensureWarmPool(): Promise<void> {
    const needed = this.config.pool.minWarm - this.state.warmPool.size;

    if (needed <= 0) return;

    // Check we won't exceed max total
    const currentTotal = this.state.containers.size;
    const canCreate = Math.min(needed, this.config.pool.maxTotal - currentTotal);

    for (let i = 0; i < canCreate; i++) {
      try {
        await this.createWarmContainer();
      } catch (err) {
        // Log error but continue
        console.error("Failed to create warm container:", err);
      }
    }
  }

  /**
   * Create a warm (unassigned) container.
   */
  private async createWarmContainer(): Promise<void> {
    // Generate a unique session key for the warm container
    const warmSessionKey = `warm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const options: ContainerCreateOptions = {
      sessionKey: warmSessionKey,
      workspaceDir: "/tmp/clawdbot-warm",
      config: this.config,
    };

    const result = await createAndStartContainer(options);

    const entry: ContainerRegistryEntry = {
      containerId: result.containerId,
      containerName: result.containerName,
      sessionKey: null, // Warm containers are unassigned
      status: "idle",
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      turnCount: 0,
      configHash: "",
    };

    await updateContainerEntry(entry);
    this.state.containers.set(result.containerName, entry);
    this.state.warmPool.add(result.containerName);
  }

  /**
   * Health check for all containers.
   */
  private async checkHealth(): Promise<void> {
    if (!this.isRunning) return;

    const staleThreshold = this.config.timeouts.healthIntervalMs * 6; // 6 missed heartbeats
    const staleContainers = await getStaleContainers(staleThreshold);

    for (const container of staleContainers) {
      // Verify with Docker
      const state = await getContainerState(container.containerName);

      if (!state.exists || !state.running) {
        // Container died, clean up
        await this.removeContainerByName(container.containerName);
      } else {
        // Container running but no heartbeat - mark as failed
        await updateContainerStatus(container.containerName, "failed");
        if (container.sessionKey) {
          this.state.sessionToContainer.delete(container.sessionKey);
        }
      }
    }
  }

  /**
   * Maintenance tasks (cleanup idle/expired containers).
   */
  private async maintenance(): Promise<void> {
    if (!this.isRunning) return;

    // Clean up idle containers (beyond warm pool needs)
    const idleContainers = await getIdleContainers(this.config.timeouts.idleMs);
    const keepWarm = Math.max(0, this.config.pool.minWarm - this.state.warmPool.size);

    // Sort by last heartbeat, oldest first
    idleContainers.sort((a, b) => a.lastHeartbeat - b.lastHeartbeat);

    // Remove oldest idle containers beyond what we need for warm pool
    const toRemove = idleContainers.slice(keepWarm);
    for (const container of toRemove) {
      await this.removeContainerByName(container.containerName);
    }

    // Clean up expired containers (past max age)
    const expiredContainers = await getExpiredContainers(this.config.timeouts.maxAgeMs);
    for (const container of expiredContainers) {
      await this.removeContainerByName(container.containerName);
    }

    // Ensure warm pool is maintained
    await this.ensureWarmPool();
  }

  /**
   * Shutdown all containers and clean up.
   */
  async shutdown(): Promise<void> {
    await this.stop();

    // Stop all containers
    for (const [name] of this.state.containers) {
      try {
        await stopContainer(name);
        await removeContainer(name);
        await removeContainerEntry(name);
      } catch {
        // Ignore errors during shutdown
      }
    }

    this.state.containers.clear();
    this.state.sessionToContainer.clear();
    this.state.warmPool.clear();
  }

  /**
   * Get container name for a session.
   */
  getContainerNameForSession(sessionKey: string): string | undefined {
    return this.state.sessionToContainer.get(sessionKey);
  }

  /**
   * Check if pool manager is running.
   */
  isHealthy(): boolean {
    return this.isRunning;
  }
}

/**
 * Create a pool manager instance.
 */
export function createPoolManager(config: DockerCCPoolConfig): DockerCCPoolManager {
  return new DockerCCPoolManager(config);
}
