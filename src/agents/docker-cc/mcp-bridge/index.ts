/**
 * MCP server entry point for Clawdbot tools.
 *
 * This module runs as a stdio MCP server inside Docker containers,
 * exposing Clawdbot tools to Claude Code via the Model Context Protocol.
 *
 * Environment variables:
 * - SESSION_ID: Current session identifier
 * - REDIS_URL: Redis connection URL
 * - GATEWAY_URL: Clawdbot gateway URL
 * - GATEWAY_TOKEN: Optional gateway auth token
 * - PARENT_SESSION_ID: Optional parent session ID
 */

import * as readline from "node:readline";
import type { McpBridgeContext } from "./types.js";
import { executeToolByName, getToolDefinitions } from "./tool-registry.js";

/**
 * MCP protocol version.
 */
const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Server info.
 */
const SERVER_INFO = {
  name: "clawdbot-mcp",
  version: "1.0.0",
};

/**
 * JSON-RPC request.
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC response.
 */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Load context from environment.
 */
function loadContextFromEnv(): McpBridgeContext {
  const sessionId = process.env.SESSION_ID;
  if (!sessionId) {
    throw new Error("SESSION_ID environment variable is required");
  }

  return {
    sessionId,
    parentSessionId: process.env.PARENT_SESSION_ID,
    gatewayUrl: process.env.GATEWAY_URL ?? "http://gateway:8000",
    gatewayToken: process.env.GATEWAY_TOKEN,
    redisUrl: process.env.REDIS_URL ?? "redis://redis:6379",
    workspacePath: process.env.WORKSPACE_PATH ?? "/workspace",
  };
}

/**
 * Handle MCP initialize request.
 */
function handleInitialize(): unknown {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: SERVER_INFO,
  };
}

/**
 * Handle MCP tools/list request.
 */
function handleToolsList(): unknown {
  const tools = getToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  return { tools };
}

/**
 * Handle MCP tools/call request.
 */
async function handleToolsCall(
  params: { name: string; arguments?: Record<string, unknown> },
  context: McpBridgeContext,
): Promise<unknown> {
  const result = await executeToolByName(params.name, params.arguments ?? {}, context);

  return result;
}

/**
 * Process a single JSON-RPC request.
 */
async function processRequest(
  request: JsonRpcRequest,
  context: McpBridgeContext,
): Promise<JsonRpcResponse> {
  try {
    let result: unknown;

    switch (request.method) {
      case "initialize":
        result = handleInitialize();
        break;

      case "initialized":
        // Notification, no response needed
        result = {};
        break;

      case "tools/list":
        result = handleToolsList();
        break;

      case "tools/call":
        result = await handleToolsCall(
          request.params as { name: string; arguments?: Record<string, unknown> },
          context,
        );
        break;

      case "ping":
        result = {};
        break;

      default:
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        };
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message,
      },
    };
  }
}

/**
 * Send a JSON-RPC response to stdout.
 */
function sendResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}

/**
 * Run the MCP server (stdio transport).
 */
async function runServer(): Promise<void> {
  const context = loadContextFromEnv();

  console.error(`[clawdbot-mcp] Starting MCP server for session ${context.sessionId}`);
  console.error(`[clawdbot-mcp] Gateway: ${context.gatewayUrl}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = await processRequest(request, context);

      // Only send response for requests (not notifications)
      if (request.id !== null) {
        sendResponse(response);
      }
    } catch {
      // JSON parse error
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      });
    }
  });

  rl.on("close", () => {
    console.error("[clawdbot-mcp] Server shutting down");
    process.exit(0);
  });

  // Handle signals
  process.on("SIGTERM", () => {
    console.error("[clawdbot-mcp] Received SIGTERM");
    rl.close();
  });

  process.on("SIGINT", () => {
    console.error("[clawdbot-mcp] Received SIGINT");
    rl.close();
  });
}

// Run if executed directly
runServer().catch((err) => {
  console.error(`[clawdbot-mcp] Fatal error: ${err}`);
  process.exit(1);
});

// Export for testing
export { handleInitialize, handleToolsList, handleToolsCall, processRequest, loadContextFromEnv };
