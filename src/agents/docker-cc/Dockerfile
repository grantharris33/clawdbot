# Docker CC - Claude Code in Docker
#
# This image runs Claude Code CLI inside Docker containers with:
# - TypeScript wrapper for session management
# - Redis-based communication
# - MCP servers for extended capabilities
# - Playwright for browser automation

FROM node:22-slim

# Install system dependencies for Playwright and general tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install MCP servers
RUN npm install -g \
    @modelcontextprotocol/server-filesystem \
    @executeautomation/playwright-mcp-server \
    ioredis

# Install Playwright browsers (chromium only to save space)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npx playwright install chromium --with-deps || true

# Create directories
RUN mkdir -p /opt/wrapper /opt/cc-docker-mcp /workspace /shared

# Copy wrapper code (built TypeScript)
COPY container-wrapper/dist /opt/wrapper

# Copy MCP bridge (built TypeScript)
COPY mcp-bridge/dist /opt/cc-docker-mcp

# Create non-root user
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /workspace /shared /opt/wrapper

# Create Claude config directory
RUN mkdir -p /home/claude/.claude && \
    chown -R claude:claude /home/claude/.claude

# Set working directory
WORKDIR /workspace

# Switch to non-root user
USER claude

# Environment defaults
ENV NODE_ENV=production \
    CLAUDE_CODE_ENTRYPOINT=clawdbot-docker-cc \
    WORKSPACE_PATH=/workspace \
    REDIS_URL=redis://redis:6379

# Health check via Redis heartbeat
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('ioredis').createClient(process.env.REDIS_URL).ping().then(() => process.exit(0)).catch(() => process.exit(1))" || exit 1

# Entry point
ENTRYPOINT ["node", "/opt/wrapper/index.js"]
