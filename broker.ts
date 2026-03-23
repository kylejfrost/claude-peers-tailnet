#!/usr/bin/env bun
/**
 * claude-peers broker daemon (tailnet-aware fork)
 *
 * Central broker that runs on Apollo mini. Peers from any machine on the
 * tailnet can register, discover each other, and exchange messages.
 *
 * Key changes from upstream:
 * - Binds to 0.0.0.0 (not 127.0.0.1) so remote machines can connect
 * - Uses heartbeat-based liveness instead of PID checks (PIDs are local)
 * - Tracks hostname per peer for cross-machine identification
 * - Optional auth token for security (CLAUDE_PEERS_TOKEN)
 *
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { hostname as osHostname } from "os";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";
const STALE_TIMEOUT_MS = 60_000; // peers not seen in 60s are considered dead
const LOCAL_HOSTNAME = osHostname();

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Add hostname column if missing (upgrade path)
try {
  db.run("ALTER TABLE peers ADD COLUMN hostname TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

// Clean stale peers based on heartbeat timeout (works for remote peers too)
function cleanStalePeers() {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();
  const stale = db.query("SELECT id, hostname FROM peers WHERE last_seen < ?").all(cutoff) as { id: string; hostname: string }[];
  for (const peer of stale) {
    db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    console.error(`[broker] Cleaned stale peer ${peer.id} (${peer.hostname})`);
  }

  // Also check local peers by PID (faster detection for local processes)
  const localPeers = db.query("SELECT id, pid FROM peers WHERE hostname = ?").all(LOCAL_HOSTNAME) as { id: string; pid: number }[];
  for (const peer of localPeers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      console.error(`[broker] Cleaned dead local peer ${peer.id} (pid ${peer.pid})`);
    }
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, 15_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, hostname, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
const selectAllPeers = db.prepare("SELECT * FROM peers");
const insertMessage = db.prepare("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)");
const selectUndelivered = db.prepare("SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC");
const markDelivered = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Auth middleware ---

function checkAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) return null; // no auth configured
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (token !== AUTH_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const peerHostname = body.hostname ?? LOCAL_HOSTNAME;

  // Remove existing registration for same PID + hostname
  const existing = db.query("SELECT id FROM peers WHERE pid = ? AND hostname = ?").get(body.pid, peerHostname) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, peerHostname, now, now);
  return { id };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers = selectAllPeers.all() as Peer[];

  // scope filtering still works, but "machine" now means "all machines"
  if (body.scope === "directory") {
    peers = peers.filter(p => p.cwd === body.cwd);
  } else if (body.scope === "repo" && body.git_root) {
    peers = peers.filter(p => p.git_root === body.git_root);
  }

  if (body.exclude_id) {
    peers = peers.filter(p => p.id !== body.exclude_id);
  }

  return peers;
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }
  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }
  return { messages };
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // bind to all interfaces for tailnet access
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return Response.json({
        status: "ok",
        hostname: LOCAL_HOSTNAME,
        peers: (selectAllPeers.all() as Peer[]).length,
      });
    }

    if (req.method !== "POST") {
      return new Response("claude-peers broker (tailnet)", { status: 200 });
    }

    const authErr = checkAuth(req);
    if (authErr) return authErr;

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          updateLastSeen.run(new Date().toISOString(), (body as HeartbeatRequest).id);
          return Response.json({ ok: true });
        case "/set-summary":
          updateSummary.run((body as SetSummaryRequest).summary, (body as SetSummaryRequest).id);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          deletePeer.run((body as { id: string }).id);
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (db: ${DB_PATH}, host: ${LOCAL_HOSTNAME})`);
