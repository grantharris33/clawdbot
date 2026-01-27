/**
 * Configuration file generator for Claude Code container.
 *
 * Port of CC-Docker config_generator.py to TypeScript.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServerConfig } from "./types.js";

/**
 * Generate all Claude Code configuration files.
 */
export class ConfigGenerator {
  private sessionId: string;
  private workspacePath: string;
  private redisUrl: string;
  private gatewayUrl: string;
  private parentSessionId?: string;
  private containerRole: string;
  private mcpServers: Record<string, McpServerConfig>;

  constructor(params: {
    sessionId: string;
    workspacePath?: string;
    redisUrl?: string;
    gatewayUrl?: string;
    parentSessionId?: string;
    containerRole?: string;
    mcpServers?: Record<string, McpServerConfig>;
  }) {
    this.sessionId = params.sessionId;
    this.workspacePath = params.workspacePath ?? "/workspace";
    this.redisUrl = params.redisUrl ?? "redis://redis:6379";
    this.gatewayUrl = params.gatewayUrl ?? "http://gateway:8000";
    this.parentSessionId = params.parentSessionId;
    this.containerRole = params.containerRole ?? "worker";
    this.mcpServers = params.mcpServers ?? {};
  }

  /**
   * Generate all configuration files.
   */
  async generateAll(): Promise<void> {
    console.log(`Generating configuration files for session ${this.sessionId}`);

    await this.createDirectories();
    await this.generateMcpJson();
    await this.generateSettingsJson();
    await this.generateClaudeMd();

    console.log("Configuration files generated successfully");
  }

  /**
   * Create required directories.
   */
  private async createDirectories(): Promise<void> {
    const dirs = [
      path.join(this.workspacePath, ".claude"),
      path.join(this.workspacePath, ".claude", "skills"),
      "/home/claude/.claude",
    ];

    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      } catch {
        // Directory may already exist
      }
    }
  }

  /**
   * Generate .mcp.json file.
   */
  private async generateMcpJson(): Promise<void> {
    const mcpConfig: { mcpServers: Record<string, unknown> } = {
      mcpServers: {
        // CC-Docker MCP server for inter-session communication
        "cc-docker": {
          type: "stdio",
          command: "node",
          args: ["/opt/cc-docker-mcp/index.js"],
          env: {
            SESSION_ID: this.sessionId,
            REDIS_URL: this.redisUrl,
            GATEWAY_URL: this.gatewayUrl,
          },
        },
        // Filesystem MCP server
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace", "/shared"],
        },
        // Playwright MCP server
        playwright: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@executeautomation/playwright-mcp-server", "--headless"],
          env: {
            PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright-browsers",
          },
        },
      },
    };

    // Add conditional MCP servers based on environment
    if (process.env.GITHUB_TOKEN) {
      mcpConfig.mcpServers.github = {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        },
      };
    }

    if (process.env.POSTGRES_URL) {
      mcpConfig.mcpServers.postgres = {
        type: "stdio",
        command: "npx",
        args: ["-y", "@bytebase/dbhub"],
        env: {
          DATABASE_URL: process.env.POSTGRES_URL,
        },
      };
    }

    // Merge custom MCP servers
    for (const [name, config] of Object.entries(this.mcpServers)) {
      mcpConfig.mcpServers[name] = config;
    }

    const mcpPath = path.join(this.workspacePath, ".mcp.json");
    await fs.writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`Generated ${mcpPath}`);
  }

  /**
   * Generate settings.json file.
   */
  private async generateSettingsJson(): Promise<void> {
    const settings = {
      permissions: {
        allow: [
          "Bash(*)",
          "Read(*)",
          "Write(*)",
          "Edit(*)",
          "Glob(*)",
          "Grep(*)",
          "WebFetch(*)",
          "Task(*)",
          "mcp__cc-docker__*",
          "mcp__filesystem__*",
          "mcp__playwright__*",
        ],
        deny: [],
        defaultMode: "bypassPermissions",
      },
      env: {
        SESSION_ID: this.sessionId,
        REDIS_URL: this.redisUrl,
        GATEWAY_URL: this.gatewayUrl,
        MCP_TIMEOUT: "30000",
        MAX_MCP_OUTPUT_TOKENS: "50000",
      } as Record<string, string>,
    };

    if (this.parentSessionId) {
      settings.env.PARENT_SESSION_ID = this.parentSessionId;
    }

    // Add permissions for optional MCP servers
    if (process.env.GITHUB_TOKEN) {
      settings.permissions.allow.push("mcp__github__*");
    }

    if (process.env.POSTGRES_URL) {
      settings.permissions.allow.push("mcp__postgres__*");
    }

    const settingsPath = "/home/claude/.claude/settings.json";
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`Generated ${settingsPath}`);
  }

  /**
   * Generate CLAUDE.md file with session context.
   */
  private async generateClaudeMd(): Promise<void> {
    const parentInfo = this.parentSessionId
      ? `- **Parent Session**: ${this.parentSessionId}`
      : "- **Parent Session**: None (root session)";

    let content = `# CC-Docker Session Context

## Session Information
- **Session ID**: ${this.sessionId}
${parentInfo}
- **Container Role**: ${this.containerRole}

## Available Capabilities

### MCP Servers
- **cc-docker**: Inter-session communication (spawn_child, send_to_child, get_child_output, get_child_result, list_children, stop_child)
- **filesystem**: Enhanced file operations in /workspace and /shared
- **playwright**: Headless browser automation for web scraping and testing
`;

    // Add conditional servers
    if (process.env.GITHUB_TOKEN) {
      content += "- **github**: GitHub repository management, PRs, issues\n";
    }

    if (process.env.POSTGRES_URL) {
      content += "- **postgres**: PostgreSQL database queries and schema management\n";
    }

    content += `
## Guidelines

### When to Use Docker Children (spawn_child)
- Task needs isolation (separate workspace, fresh context)
- Task is long-running (>30 seconds)
- Task can run in parallel with other work
- Task involves heavy computation or many file operations
- Multi-file refactoring, parallel code review, research tasks

### When to Use Built-in Task Tool Instead
- Quick code exploration or file search
- Simple questions that need codebase context
- Tasks that benefit from shared parent context

## Best Practices
- Break large tasks into smaller, focused subtasks
- Each child should have a single, clear objective
- Provide enough context but avoid overwhelming the child
- Use streaming for long-running tasks to monitor progress
- Always check child results before proceeding
- Clean up completed children to free resources

## Resource Limits
- Maximum concurrent children: 5 (configurable)
- Maximum child depth: 3 (prevent infinite recursion)
- Child timeout: 30 minutes (configurable)
`;

    const claudeMdPath = path.join(this.workspacePath, ".claude", "CLAUDE.md");
    await fs.writeFile(claudeMdPath, content);
    console.log(`Generated ${claudeMdPath}`);
  }
}
