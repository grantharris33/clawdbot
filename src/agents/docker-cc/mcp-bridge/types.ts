/**
 * Types for the MCP bridge that exposes Clawdbot tools to Docker containers.
 */

/**
 * MCP tool definition (simplified schema for tool registration).
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP tool call request.
 */
export interface McpToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * MCP tool call result.
 */
export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * MCP content block.
 */
export type McpContentBlock = McpTextContent | McpImageContent | McpResourceContent;

/**
 * MCP text content.
 */
export interface McpTextContent {
  type: "text";
  text: string;
}

/**
 * MCP image content.
 */
export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * MCP resource content.
 */
export interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

/**
 * Gateway connection options for MCP bridge.
 */
export interface McpBridgeGatewayOptions {
  url?: string;
  token?: string;
  password?: string;
  timeout?: number;
}

/**
 * MCP bridge context (passed to tool execution).
 */
export interface McpBridgeContext {
  sessionId: string;
  parentSessionId?: string;
  gatewayUrl: string;
  gatewayToken?: string;
  redisUrl: string;
  workspacePath: string;
}

/**
 * MCP server configuration for bridge.
 */
export interface McpBridgeServerConfig {
  name: string;
  version: string;
  tools: McpToolDefinition[];
}

/**
 * Tool execution function signature.
 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  context: McpBridgeContext,
) => Promise<McpToolCallResult>;
