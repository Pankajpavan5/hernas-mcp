import { homedir } from "node:os";
import { join } from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

const dataDir = process.env.HERNAS_DATA ?? join(homedir(), ".hernas");

export const config = {
  port: num("HERNAS_PORT", Number(process.env.PORT) || 7420),
  // Loopback by default. Remote access is opt-in and warned about at boot.
  host: process.env.HERNAS_HOST ?? "127.0.0.1",
  dataDir,
  dbPath: join(dataDir, "hernas.db"),
  keyPath: join(dataDir, "key.json"),

  mcpPath: process.env.HERNAS_MCP_PATH ?? "/mcp",
  // Optional bearer for /mcp. Empty = open (fine on loopback); set it when hosting off-box.
  mcpKey: process.env.HERNAS_MCP_KEY ?? "",
  relayToken: process.env.HERNAS_RELAY_TOKEN ?? "",

  // --- agent bridge loop guards (per thread unless noted) ---
  maxHops: num("HERNAS_MAX_HOPS", 12),
  maxTurnsPerAgent: num("HERNAS_MAX_TURNS", 4),
  cooldownMs: num("HERNAS_COOLDOWN_MS", 1500),
  threadTokenBudget: num("HERNAS_THREAD_TOKENS", 60_000),
  messageTtlHours: num("HERNAS_MESSAGE_TTL_H", 24),

  // --- piggyback ---
  attachMaxMessages: num("HERNAS_ATTACH_MAX", 10),
  attachMaxBytes: num("HERNAS_ATTACH_BYTES", 8000),

  // --- device ---
  devicePollSeconds: num("HERNAS_POLL_SECONDS", 25),
  deviceCommandTimeoutMs: num("HERNAS_CMD_TIMEOUT_MS", 90_000),
  maxOutputBytes: num("HERNAS_MAX_OUTPUT", 512 * 1024),

  // --- auth ---
  sessionIdleMs: num("HERNAS_SESSION_IDLE_MS", 12 * 3600_000),
  failWindowMs: 60_000,
  maxFails: 5,
};

export type Config = typeof config;
