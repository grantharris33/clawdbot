---
title: Docker Claude Code
description: Run Claude Code in isolated Docker containers with full tool access
---

# Docker Claude Code Provider

Docker Claude Code runs Claude Code CLI in isolated Docker containers, providing:

- **Subscription-based execution**: Uses Claude Code's subscription model instead of API calls
- **Full streaming**: Real-time streaming of responses to messaging channels
- **Tool access**: All Clawdbot tools available via MCP bridge
- **Container pooling**: Warm container pool for fast session startup
- **Multi-agent routing**: Multiple concurrent sessions with Redis-based communication

## Quick Start

### Prerequisites

1. **Docker** installed and running
2. **Redis** server accessible (local or remote)
3. **Claude Code CLI** authentication configured

### Enable Docker Claude Code

Add to your `~/.clawdbot/config.yaml`:

```yaml
agents:
  defaults:
    model:
      primary: docker-claude-code/opus
      fallbacks:
        - claude-cli/opus
        - anthropic/claude-sonnet-4-5

    dockerClaudeCode:
      enabled: true
      pool:
        minWarm: 2      # Warm containers for fast startup
        maxTotal: 10    # Maximum concurrent containers
        maxPerAgent: 3  # Max containers per agent
      image: clawdbot/docker-cc:latest
      resources:
        memory: 4g
        cpus: 2
      redis:
        url: redis://localhost:6379
```

### Start Redis

```bash
# Using Docker
docker run -d --name redis -p 6379:6379 redis:alpine

# Or using docker-compose (see below)
```

### Build the Docker Image

```bash
cd src/agents/docker-cc
docker build -t clawdbot/docker-cc:latest .
```

## Configuration Reference

### Pool Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minWarm` | number | 0 | Minimum warm containers to maintain |
| `maxTotal` | number | 10 | Maximum total containers allowed |
| `maxPerAgent` | number | 3 | Maximum containers per agent |

### Resources

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `memory` | string | "4g" | Container memory limit |
| `cpus` | number | 2 | CPU limit |
| `pidsLimit` | number | 256 | Max PIDs in container |

### Timeouts

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `idleMs` | number | 300000 | Idle timeout (5 min) |
| `maxAgeMs` | number | 3600000 | Max container age (1 hour) |
| `healthIntervalMs` | number | 10000 | Health check interval (10s) |
| `startupMs` | number | 30000 | Container startup timeout (30s) |

### Redis

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | `REDIS_URL` env | Redis connection URL |
| `keyPrefix` | string | "clawdbot:cc:" | Key prefix for all Redis keys |

### Docker

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `containerPrefix` | string | "clawdbot-cc-" | Container name prefix |
| `network` | string | "clawdbot-net" | Docker network name |
| `capDrop` | string[] | ["ALL"] | Capabilities to drop |
| `securityOpts` | string[] | ["no-new-privileges"] | Security options |
| `binds` | string[] | - | Additional volume binds |
| `env` | object | - | Additional environment variables |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Clawdbot Gateway (Node.js)                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ DockerCCRunner                                              ││
│  │  - Pool manager (create/scale/health/assign)                ││
│  │  - Redis pub/sub communication                              ││
│  │  - Stream parser (stream-json → ReplyDispatcher)            ││
│  │  - MCP server (exposes Clawdbot tools)                      ││
│  └─────────────────────────────────────────────────────────────┘│
│  Existing: Channels, Routing, Sessions, ReplyDispatcher, Tools  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Docker API + Redis
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Docker Claude Code Container Pool                   │
│  - Claude Code CLI with full tools                              │
│  - TypeScript wrapper for session management                    │
│  - MCP client → Clawdbot gateway for tools                      │
│  - Streaming JSON output → Redis pub/sub                        │
└─────────────────────────────────────────────────────────────────┘
```

## Redis Communication

The provider uses Redis for all container communication:

| Key Pattern | Type | Description |
|-------------|------|-------------|
| `clawdbot:cc:{session}:input` | List | Input queue (RPUSH/BLPOP) |
| `clawdbot:cc:{session}:output` | Pub/Sub | Real-time output stream |
| `clawdbot:cc:{session}:output_buffer` | List | Buffered output (max 1000) |
| `clawdbot:cc:{session}:state` | Hash | Container state + heartbeat |
| `clawdbot:cc:{session}:result` | String | Final result |
| `clawdbot:cc:{session}:control` | Pub/Sub | Interrupt signals |

## MCP Tools

Docker containers have access to all Clawdbot tools via the MCP bridge:

### Session Tools
- `sessions_list` - List active sessions
- `sessions_history` - Get session message history
- `sessions_send` - Send message to session
- `sessions_spawn` - Spawn child session
- `session_status` - Get session status

### Messaging
- `message` - Send message to any channel

### Web Tools
- `web_search` - Search the web
- `web_fetch` - Fetch URL content

### System Tools
- `agents_list` - List configured agents
- `nodes_list` - List connected nodes
- `nodes_exec` - Execute on remote node
- `cron_list` - List cron jobs
- `cron_create` - Create cron job
- `cron_delete` - Delete cron job
- `config_get` - Get configuration

## Docker Compose Example

```yaml
version: '3.8'

services:
  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  clawdbot-gateway:
    image: node:22-slim
    volumes:
      - ./:/app
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
    network_mode: host

networks:
  default:
    name: clawdbot-net

volumes:
  redis-data:
```

## Health Monitoring

Check Docker CC health status:

```bash
# Via CLI (when implemented)
clawdbot docker-cc status

# Via gateway API
curl http://localhost:18789/api/docker-cc/health
```

## Troubleshooting

### Container Won't Start

1. Check Docker daemon is running:
   ```bash
   docker info
   ```

2. Check Redis is accessible:
   ```bash
   redis-cli ping
   ```

3. Check container logs:
   ```bash
   docker logs clawdbot-cc-<session>
   ```

### No Response from Container

1. Check container health:
   ```bash
   docker ps -a --filter "label=clawdbot.docker-cc=1"
   ```

2. Check Redis heartbeats:
   ```bash
   redis-cli hgetall "clawdbot:cc:<session>:state"
   ```

3. Check container output buffer:
   ```bash
   redis-cli lrange "clawdbot:cc:<session>:output_buffer" 0 -1
   ```

### Slow Startup

1. Increase warm pool size in config
2. Pre-pull the Docker image:
   ```bash
   docker pull clawdbot/docker-cc:latest
   ```

## Fallback Chain

Docker Claude Code integrates with Clawdbot's fallback system:

```yaml
model:
  primary: docker-claude-code/opus
  fallbacks:
    - claude-cli/opus        # Falls back to CLI if Docker unavailable
    - anthropic/claude-sonnet-4-5  # Falls back to API if CLI fails
```

If Docker CC is unavailable (Redis down, Docker not running), the request automatically falls back to the next provider in the chain.
