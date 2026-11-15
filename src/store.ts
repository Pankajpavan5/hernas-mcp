import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '', capabilities TEXT NOT NULL DEFAULT '',
  online INTEGER NOT NULL DEFAULT 1, last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
  hops INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
  created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '*', body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal', ttl REAL NOT NULL, created REAL NOT NULL,
  hops INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', delivered_at REAL
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient, state, created);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, tool TEXT NOT NULL,
  agent TEXT NOT NULL, device TEXT, args TEXT, ok INTEGER NOT NULL, ms INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export type Agent = {
  id: string; name: string; role: string; client: string;
  capabilities: string; online: number; last_seen: number;
};

export type Thread = {
  id: string; subject: string; state: string; hops: number;
  tokens: number; created: number; updated: number;
};

export type Message = {
  id: string; thread_id: string; sender: string; recipient: string; body: string;
  priority: string; ttl: number; created: number; hops: number;
  state: string; delivered_at: number | null;
};

export type AuditRow = {
  id: number; ts: number; tool: string; agent: string; device: string | null;
  args: string | null; ok: number; ms: number; error: string | null;
};

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- agents
  upsertAgent(a: Partial<Agent> & { id: string; name: string }): Agent {
    const now = Date.now() / 1000;
    this.db
      .prepare(
        `INSERT INTO agents (id, name, role, client, capabilities, online, last_seen)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
           client=excluded.client, capabilities=excluded.capabilities,
           online=1, last_seen=excluded.last_seen`,
      )
      .run(a.id, a.name, a.role ?? "", a.client ?? "", a.capabilities ?? "", now);
    return this.getAgent(a.id)!;
  }

  getAgent(id: string): Agent | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
  }

  listAgents(): Agent[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY last_seen DESC").all() as Agent[];
  }

  markOffline(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE agents SET online = 0 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  // --------------------------------------------------------------- threads
  getThread(id: string): Thread | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
  }

  ensureThread(id: string, subject = ""): Thread {
    const now = Date.now() / 1000;
    this.db
      .prepare(
        `INSERT INTO threads (id, subject, state, hops, tokens, created, updated)
         VALUES (?, ?, 'open', 0, 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, subject, now, now);
    return this.getThread(id)!;
  }

  setThreadState(id: string, state: string): void {
    this.db
      .prepare("UPDATE threads SET state = ?, updated = ? WHERE id = ?")
      .run(state, Date.now() / 1000, id);
  }

  bumpThread(id: string, tokens: number): void {
    this.db
      .prepare("UPDATE threads SET hops = hops + 1, tokens = tokens + ?, updated = ? WHERE id = ?")
      .run(tokens, Date.now() / 1000, id);
  }

  listThreads(): Thread[] {
    return this.db
      .prepare("SELECT * FROM threads ORDER BY updated DESC LIMIT 100")
      .all() as Thread[];
  }

  /** How many messages this agent already sent in this thread - the turn budget. */
  countTurns(threadId: string, sender: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND sender = ?")
      .get(threadId, sender) as { n: number };
    return row.n;
  }

  /** Timestamp of this agent's last message in this thread - the cooldown. */
  lastSentAt(threadId: string, sender: string): number {
    const row = this.db
      .prepare("SELECT MAX(created) AS t FROM messages WHERE thread_id = ? AND sender = ?")
      .get(threadId, sender) as { t: number | null };
    return row.t ?? 0;
  }

  // -------------------------------------------------------------- messages
  insertMessage(m: Message): boolean {
    // Dedupe on id: a retried send must not create a second copy.
    const res = this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, sender, recipient, body, priority, ttl,
                               created, hops, state, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        m.id, m.thread_id, m.sender, m.recipient, m.body, m.priority,
        m.ttl, m.created, m.hops, m.state, m.delivered_at,
      );
    return Number(res.changes) > 0;
  }

  getMessage(id: string): Message | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message | undefined;
  }

  /** Pending messages for one agent, highest priority first, expired ones excluded. */
  inbox(recipient: string, limit: number, now = Date.now() / 1000): Message[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE recipient = ? AND state = 'pending' AND created + ttl > ?
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created
         LIMIT ?`,
      )
      .all(recipient, now, limit) as Message[];
  }

  countPending(recipient: string, now = Date.now() / 1000): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND state = 'pending' AND created + ttl > ?",
      )
      .get(recipient, now) as { n: number };
    return row.n;
  }

  markDelivered(ids: string[], now = Date.now() / 1000): void {
    const stmt = this.db.prepare(
      "UPDATE messages SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'pending'",
    );
    for (const id of ids) stmt.run(now, id);
  }

  threadMessages(threadId: string, limit = 200): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created ASC LIMIT ?")
      .all(threadId, limit) as Message[];
  }

  // ----------------------------------------------------------------- audit
  audit(row: Omit<AuditRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO audit (ts, tool, agent, device, args, ok, ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.ts, row.tool, row.agent, row.device, row.args, row.ok, row.ms, row.error);
  }

  listAudit(limit = 50): AuditRow[] {
    return this.db
      .prepare("SELECT * FROM audit ORDER BY ts DESC LIMIT ?")
      .all(limit) as AuditRow[];
  }

  // -------------------------------------------------------------------- kv
  kvGet(k: string): string | undefined {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return row?.v;
  }

  kvSet(k: string, v: string): void {
    this.db
      .prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(k, v);
  }
}
