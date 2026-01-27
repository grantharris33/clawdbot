/**
 * Tool registry for MCP bridge.
 *
 * Registers all Clawdbot tools as MCP tools that can be called from
 * Docker containers via the CC-Docker MCP server.
 */

import type {
  McpBridgeContext,
  McpToolCallResult,
  McpToolDefinition,
  ToolExecutor,
} from "./types.js";
import { createGatewayClientFromContext } from "./gateway-client.js";
import { createErrorResult, createJsonResult } from "./result-converter.js";

/**
 * All registered MCP tools.
 */
const TOOLS: McpToolDefinition[] = [
  // Session management tools
  {
    name: "sessions_list",
    description:
      "List active sessions with optional filters. Returns session keys, agents, channels, and activity status.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of sessions to return" },
        activeMinutes: {
          type: "number",
          description: "Filter to sessions active within N minutes",
        },
        includeGlobal: {
          type: "boolean",
          description: "Include global/system sessions",
        },
        spawnedBy: {
          type: "string",
          description: "Filter to sessions spawned by a specific parent session",
        },
      },
    },
  },
  {
    name: "sessions_history",
    description:
      "Get message history for a specific session. Returns recent messages with timestamps and content.",
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "Session key to get history for" },
        limit: { type: "number", description: "Maximum number of messages to return" },
      },
      required: ["sessionKey"],
    },
  },
  {
    name: "sessions_send",
    description:
      "Send a message to a specific session. The message will be processed by the session's agent.",
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "Session key to send message to" },
        message: { type: "string", description: "Message content to send" },
      },
      required: ["sessionKey", "message"],
    },
  },
  {
    name: "sessions_spawn",
    description: "Spawn a new child session with a given prompt. Returns the new session key.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Initial prompt for the new session" },
        agentId: { type: "string", description: "Agent ID to use for the new session" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "session_status",
    description: "Get status of a specific session including agent, channel, and activity info.",
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "Session key to check status" },
      },
      required: ["sessionKey"],
    },
  },

  // Messaging tools
  {
    name: "message",
    description:
      "Send a message to a channel (WhatsApp, Telegram, Discord, Slack, etc.). Requires channel and recipient.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel ID (whatsapp, telegram, discord, slack, signal, imessage)",
        },
        to: {
          type: "string",
          description: "Recipient identifier (phone number, chat ID, etc.)",
        },
        message: { type: "string", description: "Message content to send" },
        threadId: {
          type: "string",
          description: "Thread ID for threaded messages (Slack, Discord)",
        },
      },
      required: ["channel", "to", "message"],
    },
  },

  // Web tools
  {
    name: "web_search",
    description:
      "Search the web using a search query. Returns relevant results with titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Maximum number of results" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch content from a URL. Optionally extract readable content using readability.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        readability: {
          type: "boolean",
          description: "Extract readable content (default: true)",
        },
      },
      required: ["url"],
    },
  },

  // Agent tools
  {
    name: "agents_list",
    description: "List all configured agents with their IDs, names, and configuration status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // Node tools
  {
    name: "nodes_list",
    description: "List all connected nodes/devices that can execute commands remotely.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "nodes_exec",
    description: "Execute a command on a remote node. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        node: { type: "string", description: "Node name or ID" },
        command: { type: "string", description: "Command to execute" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments",
        },
      },
      required: ["node", "command"],
    },
  },

  // Cron tools
  {
    name: "cron_list",
    description: "List all scheduled cron jobs with their schedules and status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "cron_create",
    description: "Create a new cron job with a schedule and command. Returns the job ID.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Job name" },
        schedule: { type: "string", description: "Cron schedule expression" },
        command: { type: "string", description: "Command to execute" },
      },
      required: ["name", "schedule", "command"],
    },
  },
  {
    name: "cron_delete",
    description: "Delete a cron job by ID.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job ID to delete" },
      },
      required: ["jobId"],
    },
  },

  // Config tools
  {
    name: "config_get",
    description: "Get gateway configuration value(s).",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Configuration key (optional, returns all if omitted)",
        },
      },
    },
  },
];

/**
 * Execute a tool by name.
 */
export const executeToolByName: ToolExecutor = async (
  name: string,
  args: Record<string, unknown>,
  context: McpBridgeContext,
): Promise<McpToolCallResult> => {
  const client = createGatewayClientFromContext(context);

  try {
    switch (name) {
      // Session tools
      case "sessions_list": {
        const result = await client.listSessions({
          limit: args.limit as number | undefined,
          activeMinutes: args.activeMinutes as number | undefined,
          includeGlobal: args.includeGlobal as boolean | undefined,
          spawnedBy: args.spawnedBy as string | undefined,
        });
        return createJsonResult(result);
      }

      case "sessions_history": {
        const result = await client.getSessionHistory({
          sessionKey: args.sessionKey as string,
          limit: args.limit as number | undefined,
        });
        return createJsonResult(result);
      }

      case "sessions_send": {
        const result = await client.sendToSession({
          sessionKey: args.sessionKey as string,
          message: args.message as string,
        });
        return createJsonResult(result);
      }

      case "sessions_spawn": {
        const result = await client.spawnSession({
          prompt: args.prompt as string,
          agentId: args.agentId as string | undefined,
          parentSessionKey: context.sessionId,
        });
        return createJsonResult(result);
      }

      case "session_status": {
        const result = await client.getSessionStatus({
          sessionKey: args.sessionKey as string,
        });
        return createJsonResult(result);
      }

      // Messaging
      case "message": {
        const result = await client.sendMessage({
          channel: args.channel as string,
          to: args.to as string,
          message: args.message as string,
          threadId: args.threadId as string | undefined,
        });
        return createJsonResult(result);
      }

      // Web tools
      case "web_search": {
        const result = await client.webSearch({
          query: args.query as string,
          limit: args.limit as number | undefined,
        });
        return createJsonResult(result);
      }

      case "web_fetch": {
        const result = await client.webFetch({
          url: args.url as string,
          readability: args.readability as boolean | undefined,
        });
        return createJsonResult(result);
      }

      // Agent tools
      case "agents_list": {
        const result = await client.listAgents();
        return createJsonResult(result);
      }

      // Node tools
      case "nodes_list": {
        const result = await client.listNodes();
        return createJsonResult(result);
      }

      case "nodes_exec": {
        const result = await client.execOnNode({
          node: args.node as string,
          command: args.command as string,
          args: args.args as string[] | undefined,
        });
        return createJsonResult(result);
      }

      // Cron tools
      case "cron_list": {
        const result = await client.listCronJobs();
        return createJsonResult(result);
      }

      case "cron_create": {
        const result = await client.createCronJob({
          name: args.name as string,
          schedule: args.schedule as string,
          command: args.command as string,
        });
        return createJsonResult(result);
      }

      case "cron_delete": {
        const result = await client.deleteCronJob({
          jobId: args.jobId as string,
        });
        return createJsonResult(result);
      }

      // Config tools
      case "config_get": {
        const result = await client.getConfig({
          key: args.key as string | undefined,
        });
        return createJsonResult(result);
      }

      default:
        return createErrorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createErrorResult(message);
  }
};

/**
 * Get all registered tool definitions.
 */
export function getToolDefinitions(): McpToolDefinition[] {
  return TOOLS;
}

/**
 * Get a specific tool definition by name.
 */
export function getToolDefinition(name: string): McpToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Check if a tool is registered.
 */
export function hasToolDefinition(name: string): boolean {
  return TOOLS.some((t) => t.name === name);
}
