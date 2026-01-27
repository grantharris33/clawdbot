/**
 * Gateway client for MCP bridge.
 *
 * Provides a simplified client for calling the Clawdbot gateway from
 * within Docker containers via the MCP bridge.
 */

import type { McpBridgeContext, McpBridgeGatewayOptions } from "./types.js";

/**
 * Default gateway timeout in milliseconds.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Make an HTTP request to the gateway.
 */
async function fetchGateway<T = unknown>(
  url: string,
  method: string,
  params: unknown,
  options: McpBridgeGatewayOptions,
): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const response = await fetch(`${url}/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gateway request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { result?: T; error?: { message?: string } };

    if (data.error) {
      throw new Error(data.error.message ?? "Gateway RPC error");
    }

    return data.result as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Gateway client for MCP bridge.
 */
export class McpGatewayClient {
  private baseUrl: string;
  private options: McpBridgeGatewayOptions;

  constructor(baseUrl: string, options: McpBridgeGatewayOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.options = options;
  }

  /**
   * Call a gateway RPC method.
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return fetchGateway<T>(this.baseUrl, method, params ?? {}, this.options);
  }

  /**
   * List sessions.
   */
  async listSessions(params?: {
    limit?: number;
    activeMinutes?: number;
    includeGlobal?: boolean;
    spawnedBy?: string;
  }): Promise<{ sessions: unknown[] }> {
    return this.call("sessions.list", params);
  }

  /**
   * Get session history.
   */
  async getSessionHistory(params: {
    sessionKey: string;
    limit?: number;
  }): Promise<{ messages: unknown[] }> {
    return this.call("sessions.history", params);
  }

  /**
   * Send message to session.
   */
  async sendToSession(params: { sessionKey: string; message: string }): Promise<{ ok: boolean }> {
    return this.call("sessions.send", params);
  }

  /**
   * Spawn a new session.
   */
  async spawnSession(params: {
    prompt: string;
    agentId?: string;
    parentSessionKey?: string;
  }): Promise<{ sessionKey: string }> {
    return this.call("sessions.spawn", params);
  }

  /**
   * Get session status.
   */
  async getSessionStatus(params: { sessionKey: string }): Promise<unknown> {
    return this.call("sessions.status", params);
  }

  /**
   * Send a message to a channel.
   */
  async sendMessage(params: {
    channel: string;
    to: string;
    message: string;
    threadId?: string;
  }): Promise<{ ok: boolean; messageId?: string }> {
    return this.call("message.send", params);
  }

  /**
   * Web search.
   */
  async webSearch(params: { query: string; limit?: number }): Promise<{ results: unknown[] }> {
    return this.call("web.search", params);
  }

  /**
   * Web fetch.
   */
  async webFetch(params: {
    url: string;
    readability?: boolean;
  }): Promise<{ content: string; title?: string }> {
    return this.call("web.fetch", params);
  }

  /**
   * Get config value.
   */
  async getConfig(params: { key?: string }): Promise<unknown> {
    return this.call("config.get", params);
  }

  /**
   * List agents.
   */
  async listAgents(): Promise<{ agents: unknown[] }> {
    return this.call("agents.list");
  }

  /**
   * List nodes.
   */
  async listNodes(): Promise<{ nodes: unknown[] }> {
    return this.call("nodes.list");
  }

  /**
   * Execute on node.
   */
  async execOnNode(params: {
    node: string;
    command: string;
    args?: string[];
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.call("nodes.exec", params);
  }

  /**
   * List cron jobs.
   */
  async listCronJobs(): Promise<{ jobs: unknown[] }> {
    return this.call("cron.list");
  }

  /**
   * Create cron job.
   */
  async createCronJob(params: {
    name: string;
    schedule: string;
    command: string;
  }): Promise<{ ok: boolean; jobId?: string }> {
    return this.call("cron.create", params);
  }

  /**
   * Delete cron job.
   */
  async deleteCronJob(params: { jobId: string }): Promise<{ ok: boolean }> {
    return this.call("cron.delete", params);
  }
}

/**
 * Create a gateway client from context.
 */
export function createGatewayClientFromContext(context: McpBridgeContext): McpGatewayClient {
  return new McpGatewayClient(context.gatewayUrl, {
    token: context.gatewayToken,
    timeout: 30000,
  });
}
