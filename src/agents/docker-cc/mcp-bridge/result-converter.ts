/**
 * Convert AgentToolResult to MCP content format.
 */

import type { McpContentBlock, McpToolCallResult } from "./types.js";

/**
 * Content item from AgentToolResult.
 */
interface AgentContentItem {
  type: "text" | "image" | "video" | "audio";
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * AgentToolResult structure.
 */
interface AgentToolResult {
  content: AgentContentItem[];
  details?: unknown;
}

/**
 * Convert an AgentToolResult to MCP format.
 */
export function convertToMcpResult(result: AgentToolResult): McpToolCallResult {
  const content: McpContentBlock[] = [];

  for (const item of result.content) {
    if (item.type === "text" && item.text) {
      content.push({
        type: "text",
        text: item.text,
      });
    } else if (item.type === "image" && item.data) {
      content.push({
        type: "image",
        data: item.data,
        mimeType: item.mimeType ?? "image/png",
      });
    }
    // Video and audio are not directly supported in MCP, convert to text reference
    else if ((item.type === "video" || item.type === "audio") && item.data) {
      content.push({
        type: "text",
        text: `[${item.type} content: ${item.mimeType ?? "unknown"}]`,
      });
    }
  }

  // If details are provided and no text content, serialize details as JSON
  if (result.details && content.length === 0) {
    content.push({
      type: "text",
      text: JSON.stringify(result.details, null, 2),
    });
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({
      type: "text",
      text: "(empty result)",
    });
  }

  return { content };
}

/**
 * Create an error result.
 */
export function createErrorResult(error: string): McpToolCallResult {
  return {
    content: [{ type: "text", text: `Error: ${error}` }],
    isError: true,
  };
}

/**
 * Create a JSON result.
 */
export function createJsonResult(data: unknown): McpToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Create a text result.
 */
export function createTextResult(text: string): McpToolCallResult {
  return {
    content: [{ type: "text", text }],
  };
}
