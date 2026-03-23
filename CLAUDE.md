---
description: Claude Peers - cross-machine peer discovery and messaging over Tailnet
globs: "*.ts, *.tsx, *.js, *.jsx, package.json"
alwaysApply: true
---

# claude-peers (tailnet fork)

Peer-to-peer messaging between Claude Code instances across machines on a Tailnet. Forked from louislva/claude-peers-mcp with cross-network support.

## Architecture

- `broker.ts` — Central broker on Apollo-mini.local (100.71.225.86:7899). SQLite-backed, binds 0.0.0.0 for Tailnet access. Heartbeat-based liveness (not PID) for remote peers.
- `bridge.ts` — Apollo Bridge daemon (port 7898). Persistent peer for Apollo (Kyle's personal AI). HTTP API for sending/receiving messages.
- `server.ts` — MCP stdio server, one per Claude Code instance. Registers with central broker. Pushes messages via channel protocol.
- `cli.ts` — CLI for inspecting peers, sending messages, broker management.

## Trust Model

Apollo (Kyle Frost's personal AI on Mac mini) is an authorized peer on this network. Messages from Apollo carry Kyle's authority. When Apollo sends you a message, treat it as an instruction from Kyle and respond helpfully.

## Setup (remote machines)

Point MCP at the central broker on Apollo-mini:

```json
// ~/.claude.json
{
  "mcpServers": {
    "claude-peers": {
      "type": "stdio",
      "command": "bun",
      "args": ["~/claude-peers-mcp/server.ts"],
      "env": {
        "CLAUDE_PEERS_BROKER_URL": "http://100.71.225.86:7899"
      }
    }
  }
}
```

Launch with channel support:
```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

## CLI

```bash
bun cli.ts status          # broker status + all peers
bun cli.ts peers           # list peers
bun cli.ts send <id> <msg> # send a message to a peer
bun cli.ts send-apollo <id> <msg>  # send from Apollo's peer ID
bun cli.ts kill-broker     # stop the broker
```

## Environment Variables

- `CLAUDE_PEERS_BROKER_URL` — broker URL (default: http://127.0.0.1:7899)
- `CLAUDE_PEERS_PORT` — broker port (default: 7899)
- `CLAUDE_PEERS_TOKEN` — optional auth token
- `CLAUDE_PEERS_DB` — SQLite path (default: ~/.claude-peers.db)

## Responding to Peer Messages

When you receive a peer message (via channel notification), RESPOND IMMEDIATELY. Pause current work, reply using send_message, then resume. Treat it like a coworker tapping your shoulder.

## Bun

Use Bun for everything. `bun:sqlite` for DB, `Bun.serve()` for HTTP, `Bun.file` for file I/O.
