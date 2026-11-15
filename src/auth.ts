import { randomInt, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCRYPT = { N: 16384, r: 8, p: 1 };

type KeyFile = { v: 1; salt: string; hash: string; created: number };

/** Compare two strings without leaking length or content through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** A 10-digit key from the CSPRNG, zero-padded. 10^10 values, never Math.random. */
export function generateKey(): string {
  return String(randomInt(0, 10_000_000_000)).padStart(10, "0");
}

function hashKey(key: string, saltHex: string): string {
  return scryptSync(key, Buffer.from(saltHex, "hex"), 64, SCRYPT).toString("hex");
}

export class Auth {
  keyPath: string;
  private salt = "";
  private hash = "";
  /** sid -> session. In memory on purpose: a restart logs everyone out. */
  private sessions = new Map<string, { csrf: string; created: number; seen: number; ip: string }>();
  private fails = new Map<string, { n: number; first: number; until: number }>();
  private tickets = new Map<string, { sid: string; exp: number }>();
  idleMs: number;

  constructor(keyPath: string, idleMs: number) {
    this.keyPath = keyPath;
    this.idleMs = idleMs;
  }

  /** Load the key hash, generating and printing a key on first run. Returns the plaintext once. */
  loadOrCreate(): { created: boolean; key?: string } {
    if (existsSync(this.keyPath)) {
      const data = JSON.parse(readFileSync(this.keyPath, "utf8")) as KeyFile;
      this.salt = data.salt;
      this.hash = data.hash;
      return { created: false };
    }
    // Hosted deploys have an ephemeral disk: allow seeding a stable key from the environment
    // instead of printing a fresh one into the logs on every boot.
    const seeded = process.env.HERNAS_ACCESS_KEY ?? "";
    const key = seeded.trim() ? seeded.trim() : generateKey();
    this.writeKey(key);
    return { created: true, key: seeded.trim() ? "(from HERNAS_ACCESS_KEY)" : key };
  }

  /** Rotate: new key, old one invalid, every session dropped. */
  rotate(): string {
    const key = generateKey();
    this.writeKey(key);
    this.sessions.clear();
    this.tickets.clear();
    return key;
  }

  private writeKey(key: string): void {
    mkdirSync(dirname(this.keyPath), { recursive: true });
    this.salt = randomBytes(16).toString("hex");
    this.hash = hashKey(key, this.salt);
    const body: KeyFile = { v: 1, salt: this.salt, hash: this.hash, created: Date.now() };
    writeFileSync(this.keyPath, JSON.stringify(body), { mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
  }

  /** Wrong key and unknown key take the same path and the same time. */
  checkKey(given: string): boolean {
    if (!/^\d{10}$/.test(given)) {
      // Still burn a hash so a malformed guess is not faster than a valid-shaped one.
      hashKey(given, this.salt || "00".repeat(16));
      return false;
    }
    return safeEqual(hashKey(given, this.salt), this.hash);
  }

  /** Returns seconds to wait, or 0 if this IP may try now. Exponential after maxFails. */
  lockoutFor(ip: string, now = Date.now()): number {
    const f = this.fails.get(ip);
    if (!f || f.until <= now) return 0;
    return Math.ceil((f.until - now) / 1000);
  }

  recordFail(ip: string, now = Date.now()): void {
    const f = this.fails.get(ip);
    if (!f || now - f.first > 60_000) {
      this.fails.set(ip, { n: 1, first: now, until: 0 });
      return;
    }
    f.n += 1;
    if (f.n >= 5) {
      const secs = Math.min(30 * 2 ** (f.n - 5), 900);
      f.until = now + secs * 1000;
    }
  }

  recordOk(ip: string): void {
    this.fails.delete(ip);
  }

  createSession(ip: string): { sid: string; csrf: string } {
    const sid = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sessions.set(sid, { csrf, created: now, seen: now, ip });
    return { sid, csrf };
  }

  getSession(sid: string | undefined): { csrf: string } | undefined {
    if (!sid) return undefined;
    const s = this.sessions.get(sid);
    if (!s) return undefined;
    const now = Date.now();
    if (now - s.seen > this.idleMs) {
      this.sessions.delete(sid);
      return undefined;
    }
    s.seen = now;
    return { csrf: s.csrf };
  }

  dropSession(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
  }

  /** Single-use, 30 s, for the WebSocket handshake. A cookie cannot be set on a WS upgrade. */
  issueTicket(sid: string): string {
    const t = randomBytes(24).toString("base64url");
    this.tickets.set(t, { sid, exp: Date.now() + 30_000 });
    return t;
  }

  consumeTicket(t: string): string | undefined {
    const found = this.tickets.get(t);
    this.tickets.delete(t);
    if (!found || found.exp < Date.now()) return undefined;
    return this.sessions.has(found.sid) ? found.sid : undefined;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
