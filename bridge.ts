#!/usr/bin/env bun
/**
 * Apollo Bridge Daemon
 *
 * Persistent process that connects Apollo (OpenClaw personal AI) to the
 * claude-peers broker. Provides:
 *   - HTTP API on port 7898 for OpenClaw to use directly
 *   - Inbox/outbox file-based messaging
 *   - Heartbeat maintenance (every 10s)
 *   - Graceful shutdown with broker unregistration
 *
 * Usage: bun bridge.ts
 */

import { existsSync, mkdirSync, unlinkSync, watch } from "fs";
import { join } from "path";
import { hostname as osHostname } from "os";
import type {
  RegisterResponse,
  PollMessagesResponse,
  Peer,
} from "./shared/types.ts";

// --- Config ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL ?? `http://127.0.0.1:${BROKER_PORT}`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";
const BRIDGE_PORT = parseInt(process.env.CLAUDE_PEERS_BRIDGE_PORT ?? "7898", 10);
const MY_HOSTNAME = "Apollo-mini.local";
const SUMMARY = "Apollo - Kyle's personal AI assistant";
const HOME = process.env.HOME ?? "/Users/apollo";
const BASE_DIR = `${HOME}/clawd/tools/claude-peers`;
const INBOX_DIR = `${BASE_DIR}/inbox`;
const OUTBOX_DIR = `${BASE_DIR}/outbox`;
const STATE_FILE = `${BASE_DIR}/.bridge-state.json`;

const HEARTBEAT_INTERVAL_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;

// --- State ---

let myId: string | null = null;
let unreadMessages: Array<{ id: number; from_id: string; text: string; sent_at: string }> = [];

// --- Ensure directories ---

for (const dir of [INBOX_DIR, OUTBOX_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Broker ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function brokerGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  const res = await fetch(`${BROKER_URL}${path}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Broker GET ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

// --- Registration ---

async function register(): Promise<void> {
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: BASE_DIR,
    git_root: null,
    tty: null,
    summary: SUMMARY,
    hostname: MY_HOSTNAME,
  });
  myId = reg.id;

  // Persist ID for CLI and other tools
  await Bun.write(STATE_FILE, JSON.stringify({ id: myId, hostname: MY_HOSTNAME, registered_at: new Date().toISOString() }));
  log(`Registered as peer ${myId}`);
}

// --- Polling ---

async function notifyOpenClaw(from_id: string, text: string): Promise<void> {
  try {
    // Look up peer info for context
    let peerInfo = "";
    try {
      const peers = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: BASE_DIR,
        git_root: null,
      });
      const sender = peers.find(p => p.id === from_id);
      if (sender) {
        peerInfo = ` (${sender.hostname}:${sender.cwd})`;
      }
    } catch {}

    const eventText = `Claude Code peer ${from_id}${peerInfo} replied: ${text}`;
    const proc = Bun.spawn(["openclaw", "system", "event", "--text", eventText, "--mode", "now"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    log(`Notified OpenClaw about message from ${from_id}`);
  } catch (e) {
    log(`OpenClaw notify failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function pollMessages(): Promise<void> {
  if (!myId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    for (const msg of result.messages) {
      // Write to inbox
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${ts}_${msg.from_id}.json`;
      await Bun.write(join(INBOX_DIR, filename), JSON.stringify(msg, null, 2));
      log(`Inbox: message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);

      // Also keep in memory for HTTP API
      unreadMessages.push({
        id: msg.id,
        from_id: msg.from_id,
        text: msg.text,
        sent_at: msg.sent_at,
      });

      // Notify OpenClaw so Apollo can relay to Kyle
      await notifyOpenClaw(msg.from_id, msg.text);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Outbox watcher ---

function watchOutbox(): void {
  const watcher = watch(OUTBOX_DIR, async (event, filename) => {
    if (!filename || !filename.endsWith(".json")) return;
    const filepath = join(OUTBOX_DIR, filename);
    // Small delay to ensure write is complete
    await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(filepath)) return;
    try {
      const text = await Bun.file(filepath).text();
      const msg = JSON.parse(text) as { to_id: string; message: string };
      if (!msg.to_id || !msg.message) {
        log(`Outbox: invalid message in ${filename}, skipping`);
        return;
      }
      if (!myId) {
        log(`Outbox: not registered yet, skipping ${filename}`);
        return;
      }
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: myId,
        to_id: msg.to_id,
        text: msg.message,
      });
      if (result.ok) {
        log(`Outbox: sent to ${msg.to_id}`);
      } else {
        log(`Outbox: send failed: ${result.error}`);
      }
      // Delete after processing (success or known failure)
      if (existsSync(filepath)) unlinkSync(filepath);
    } catch (e) {
      log(`Outbox: error processing ${filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

// --- HTTP API ---

function startHttpServer(): void {
  Bun.serve({
    port: BRIDGE_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health") {
        return Response.json({
          status: "ok",
          peer_id: myId,
          hostname: MY_HOSTNAME,
          broker_url: BROKER_URL,
        });
      }

      if (path === "/peers" && req.method === "GET") {
        try {
          const peers = await brokerFetch<Peer[]>("/list-peers", {
            scope: "machine",
            cwd: BASE_DIR,
            git_root: null,
          });
          return Response.json({ peers });
        } catch (e) {
          return Response.json({ error: String(e) }, { status: 502 });
        }
      }

      if (path === "/messages" && req.method === "GET") {
        const msgs = [...unreadMessages];
        unreadMessages = [];
        return Response.json({ messages: msgs });
      }

      if (path === "/send" && req.method === "POST") {
        if (!myId) {
          return Response.json({ error: "not registered" }, { status: 503 });
        }
        try {
          const body = await req.json() as { to_id: string; message: string };
          if (!body.to_id || !body.message) {
            return Response.json({ error: "to_id and message required" }, { status: 400 });
          }
          const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
            from_id: myId,
            to_id: body.to_id,
            text: body.message,
          });
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: String(e) }, { status: 500 });
        }
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  log(`HTTP API listening on 127.0.0.1:${BRIDGE_PORT}`);
}

// --- Logging ---

function log(msg: string) {
  console.error(`[apollo-bridge] ${msg}`);
}

// --- Cleanup ---

async function cleanup(): Promise<void> {
  if (myId) {
    try {
      await brokerFetch("/unregister", { id: myId });
      log(`Unregistered peer ${myId}`);
    } catch {
      // Best effort
    }
  }
  process.exit(0);
}

// --- Main ---

async function main() {
  log(`Starting Apollo Bridge (broker: ${BROKER_URL})`);

  // Check broker is reachable
  try {
    const health = await brokerGet<{ status: string }>("/health");
    log(`Broker healthy: ${JSON.stringify(health)}`);
  } catch (e) {
    log(`WARNING: Broker not reachable at ${BROKER_URL}: ${e instanceof Error ? e.message : String(e)}`);
    log("Retrying registration in 5s...");
    await new Promise((r) => setTimeout(r, 5000));
  }

  await register();

  // Set summary explicitly after registration
  await brokerFetch("/set-summary", { id: myId, summary: SUMMARY });

  // Start intervals
  setInterval(() => {
    if (myId) {
      brokerFetch("/heartbeat", { id: myId }).catch((e) => {
        log(`Heartbeat error: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }, HEARTBEAT_INTERVAL_MS);

  setInterval(pollMessages, POLL_INTERVAL_MS);

  // Start outbox watcher
  watchOutbox();

  // Start HTTP API
  startHttpServer();

  // Graceful shutdown
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  log("Apollo Bridge running");
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
