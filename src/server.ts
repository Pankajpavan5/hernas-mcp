import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes } from "node:crypto";

import { config } from "./config.ts";
import { Store } from "./store.ts";
import { Auth, parseCookies, safeEqual } from "./auth.ts";
import { Bridge } from "./bridge.ts";
import { RelayTransport } from "./device.ts";
import { registerTools } from "./tools.ts";
import { withAgent } from "./piggyback.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";
const COOKIE = "hernas_sid";

type Ctx = {
  store: Store;
  auth: Auth;
  bridge: Bridge;
  device: RelayTransport;
  relayToken: string;
  shotDir: string;
  clients: Set<WebSocket>;
};

function buildMcp(ctx: Ctx, notify: () => void): McpServer {
  const server = new McpServer({ name: "hernas", version: VERSION });
  registerTools(server, {
    store: ctx.store,
    bridge: ctx.bridge,
    device: ctx.device,
    attach: { maxMessages: config.attachMaxMessages, maxBytes: config.attachMaxBytes },
    shotDir: ctx.shotDir,
    onActivity: notify,
  } as never);
  return server;
}

// ------------------------------------------------------------------ helpers
function readBody(req: IncomingMessage, cap = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/** Reject cross-origin writes. Defence in depth with SameSite=Strict and the CSRF token. */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client, e.g. curl or the phone
  const host = req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function ip(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

// --------------------------------------------------------------------- boot
function boot(): Ctx {
  const store = new Store(config.dbPath);
  const auth = new Auth(config.keyPath, config.sessionIdleMs);
  const made = auth.loadOrCreate();

  // The relay token is random on first run and persisted. There is deliberately no default.
  let relayToken = config.relayToken || store.kvGet("relay_token") || "";
  if (!relayToken) {
    relayToken = randomBytes(24).toString("base64url");
    store.kvSet("relay_token", relayToken);
  }
  if (config.relayToken) store.kvSet("relay_token", config.relayToken);

  const bridge = new Bridge(store, {
    maxHops: config.maxHops,
    maxTurnsPerAgent: config.maxTurnsPerAgent,
    cooldownMs: config.cooldownMs,
    threadTokenBudget: config.threadTokenBudget,
    messageTtlHours: config.messageTtlHours,
  });
  const device = new RelayTransport(config.devicePollSeconds * 1000, config.maxOutputBytes);
  const shotDir = join(config.dataDir, "shots");

  const ctx: Ctx = { store, auth, bridge, device, relayToken, shotDir, clients: new Set() };

  if (made.created) {
    console.log(`\n  ${made.key === "(from HERNAS_ACCESS_KEY)" ? "Key seeded from HERNAS_ACCESS_KEY." : "Key generated. This is the only time it is printed:"}\n`);
    if (made.key !== "(from HERNAS_ACCESS_KEY)") console.log(`      ${made.key}\n`);
    console.log(`  It is stored only as a scrypt hash at ${config.keyPath} (mode 0600).`);
    console.log(`  Lost it? Run: npm run key:rotate\n`);
  }
  return ctx;
}

// ------------------------------------------------------------------- state
function stateSnapshot(ctx: Ctx, thread: string) {
  return {
    devices: ctx.device.list(),
    agents: ctx.store.listAgents().map((a) => ({ ...a, unread: ctx.bridge.pendingCount(a.id) })),
    threads: ctx.bridge.stats(),
    audit: ctx.store.listAudit(50),
    messages: thread ? ctx.store.threadMessages(thread, 200) : [],
    job: {
      version: VERSION,
      mcpPath: config.mcpPath,
      maxHops: config.maxHops,
      maxTurns: config.maxTurnsPerAgent,
      attachMax: config.attachMaxMessages,
      attachBytes: config.attachMaxBytes,
      jobs: ctx.device.recent(10),
    },
  };
}

// --------------------------------------------------------------------- main
function mainHttp(ctx: Ctx): void {
  // Coalesce burst updates so 50 audit rows in a second is one push, not fifty.
  let queued: NodeJS.Timeout | null = null;
  const notify = () => {
    if (queued) return;
    queued = setTimeout(() => {
      queued = null;
      const frame = JSON.stringify({ type: "state", data: stateSnapshot(ctx, "") });
      for (const ws of ctx.clients) if (ws.readyState === 1) ws.send(frame);
    }, 120);
  };

  const dashboard = readFileSync(join(HERE, "dashboard.html"), "utf8");
  const wss = new WebSocketServer({ noServer: true });

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[COOKIE];

    try {
      // ------------------------------------------------------- unauthenticated
      if (path === "/healthz") return send(res, 200, { ok: true, version: VERSION });

      if (path === "/api/login" && req.method === "POST") {
        if (!originOk(req)) return send(res, 403, { error: "bad origin" });
        const wait = ctx.auth.lockoutFor(ip(req));
        if (wait > 0) {
          return send(res, 429, { error: `too many attempts, retry in ${wait}s`, retry_after: wait });
        }
        const body = JSON.parse((await readBody(req)) || "{}") as { key?: string };
        if (!ctx.auth.checkKey(String(body.key ?? "").trim())) {
          ctx.auth.recordFail(ip(req));
          // Same message whether the key is wrong or the server has no key at all.
          return send(res, 401, { error: "wrong key" });
        }
        ctx.auth.recordOk(ip(req));
        const s = ctx.auth.createSession(ip(req));
        return send(
          res,
          200,
          { ok: true, csrf: s.csrf },
          {
            "set-cookie": `${COOKIE}=${s.sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(config.sessionIdleMs / 1000)}`,
          },
        );
      }

      // The phone's relay. Separate credential from the dashboard key.
      if (path === "/api/device/poll" && req.method === "GET") {
        const given = req.headers["x-hernas-relay-token"] ?? url.searchParams.get("token") ?? "";
        if (!safeEqual(String(given), ctx.relayToken)) return send(res, 401, { error: "relay token required" });
        const id = url.searchParams.get("device") ?? "";
        if (!id) return send(res, 400, { error: "device param required" });
        const sdk = url.searchParams.get("sdk");
        ctx.device.touch(id, url.searchParams.get("name") ?? undefined, sdk ? Number(sdk) : undefined);
        notify();
        const job = await ctx.device.take(id);
        if (!job) {
          res.writeHead(204).end();
          return;
        }
        return send(res, 200, { job_id: job.id, command: job.command, timeout_ms: job.timeoutMs });
      }

      if (path === "/api/device/result" && req.method === "POST") {
        const given = req.headers["x-hernas-relay-token"] ?? url.searchParams.get("token") ?? "";
        if (!safeEqual(String(given), ctx.relayToken)) return send(res, 401, { error: "relay token required" });
        const body = JSON.parse((await readBody(req)) || "{}") as {
          job_id?: string;
          device?: string;
          exit_code?: number;
          stdout?: string;
          stderr?: string;
          duration_ms?: number;
        };
        const done = ctx.device.finish(String(body.job_id ?? ""), String(body.device ?? ""), body);
        notify();
        if (!done) return send(res, 404, { error: "unknown job or wrong device" });
        return send(res, 200, { ok: true });
      }

      // ------------------------------------------------------------- MCP
      if (path === config.mcpPath) {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        if (config.mcpKey && !safeEqual(String(req.headers["x-hernas-key"] ?? ""), config.mcpKey)) {
          return send(res, 401, { error: "x-hernas-key required" });
        }
        const raw = await readBody(req);
        let parsed: { params?: { clientInfo?: { name?: string } } } = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "invalid JSON" });
        }
        const header = req.headers["x-hernas-agent"];
        const agentId =
          (typeof header === "string" && header) ||
          parsed.params?.clientInfo?.name?.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") ||
          "anon";

        const mcp = buildMcp(ctx, notify);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close().catch(() => {});
          mcp.close().catch(() => {});
        });
        await mcp.connect(transport);
        await withAgent(agentId, () => transport.handleRequest(req, res, parsed));
        return;
      }

      if (path === "/") return send(res, 200, dashboard);

      // ------------------------------------------------------- authenticated
      const session = ctx.auth.getSession(sid);
      if (!session) return send(res, 401, { error: "locked" });

      if (path === "/api/session" && req.method === "GET") return send(res, 200, { ok: true, csrf: session.csrf });

      if (path === "/api/logout" && req.method === "POST") {
        ctx.auth.dropSession(sid);
        return send(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }

      if (path === "/api/ticket" && req.method === "GET") {
        return send(res, 200, { ticket: ctx.auth.issueTicket(sid!) });
      }

      // Every other write needs the CSRF token and a same-origin request.
      if (req.method !== "GET") {
        if (!originOk(req)) return send(res, 403, { error: "bad origin" });
        const csrf = req.headers["x-hernas-csrf"];
        if (typeof csrf !== "string" || !safeEqual(csrf, session.csrf)) {
          return send(res, 403, { error: "bad csrf token" });
        }
      }

      if (path === "/api/state") {
        return send(res, 200, stateSnapshot(ctx, url.searchParams.get("thread") ?? ""));
      }
      if (path === "/api/metrics") {
        return send(res, 200, {
          devices: ctx.device.list().length,
          agents: ctx.store.listAgents().length,
          messages: ctx.store.listThreads().length,
          audit: ctx.store.listAudit(1).length,
          uptime_s: Math.round(process.uptime()),
        });
      }

      const threadMatch = /^\/api\/thread\/([^/]+)(\/ensure)?$/.exec(path);
      if (threadMatch) {
        const id = decodeURIComponent(threadMatch[1]);
        if (threadMatch[2]) {
          ctx.store.ensureThread(id);
          notify();
          return send(res, 200, { ok: true, thread_id: id });
        }
        return send(res, 200, {
          thread_id: id,
          messages: ctx.store.threadMessages(id, 200),
          stats: ctx.bridge.stats().find((t) => t.id === id) ?? null,
        });
      }

      if (path === "/api/say" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          thread_id?: string;
          body?: string;
          as?: string;
        };
        const threadId = String(body.thread_id ?? "");
        if (!threadId || !body.body) return send(res, 400, { error: "thread_id and body required" });
        ctx.bridge.send({
          threadId,
          from: String(body.as ?? "you").slice(0, 40),
          to: "*",
          body: String(body.body),
          bypassGuards: true,
        });
        notify();
        return send(res, 200, { ok: true });
      }

      if (path === "/api/stop" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { thread_id?: string };
        if (body.thread_id) ctx.bridge.endThread(body.thread_id);
        notify();
        return send(res, 200, { ok: true });
      }

      const shotMatch = /^\/shots\/([^/]+\.png)$/.exec(path);
      if (shotMatch) {
        const name = shotMatch[1];
        if (!/^[0-9a-f]{6,20}\.png$/.test(name)) return send(res, 404, { error: "no such shot" });
        try {
          const data = readFileSync(join(ctx.shotDir, name));
          res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
          return res.end(data);
        } catch {
          return send(res, 404, { error: "no such shot" });
        }
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "server error";
      if (!res.headersSent) send(res, 500, { error: message });
    }
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") return socket.destroy();
    const ticket = url.searchParams.get("ticket") ?? "";
    const sid = ctx.auth.consumeTicket(ticket);
    if (!sid) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ctx.clients.add(ws);
      ws.send(JSON.stringify({ type: "state", data: stateSnapshot(ctx, "") }));
      ws.on("close", () => ctx.clients.delete(ws));
      ws.on("error", () => ctx.clients.delete(ws));
    });
  });

  httpServer.listen(config.port, config.host, () => {
    const shown = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    console.log(`\n  Hernas MCP ${VERSION}`);
    console.log(`  dashboard   http://${shown}:${config.port}/`);
    console.log(`  MCP         http://${shown}:${config.port}${config.mcpPath}  (send x-hernas-agent)`);
    console.log(`  health      http://${shown}:${config.port}/healthz`);
    if (config.host === "0.0.0.0") {
      if (!config.mcpKey) console.log(`\n  WARNING: bound to 0.0.0.0 with NO key on /mcp — anyone can call tools. Set HERNAS_MCP_KEY.`);
      console.log(`\n  WARNING: bound to 0.0.0.0. The 10-digit key is ~33 bits.`);
      console.log(`  Put this behind a tunnel or a reverse proxy with TLS before exposing it.\n`);
    }
    console.log(`  relay token ${ctx.relayToken}`);
    console.log(`  data        ${config.dataDir}\n`);
  });

  const shutdown = () => {
    for (const ws of ctx.clients) ws.close();
    httpServer.close();
    ctx.store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function mainStdio(ctx: Ctx): void {
  const mcp = buildMcp(ctx, () => {});
  const transport = new StdioServerTransport();
  const agent = process.env.HERNAS_AGENT ?? "stdio";
  withAgent(agent, () => {
    mcp.connect(transport).catch((e) => {
      console.error(String(e));
      process.exit(1);
    });
  });
}

// --------------------------------------------------------------------- cli
const arg = new Set(process.argv.slice(2));
const ctx = boot();

if (arg.has("--rotate-key")) {
  const key = ctx.auth.rotate();
  console.log(`\n  New key: ${key}\n  Every session was dropped. Update your client.\n`);
  ctx.store.close();
  process.exit(0);
} else if (arg.has("--stdio")) {
  mainStdio(ctx);
} else if (arg.has("--help")) {
  console.log(`hernas-mcp ${VERSION}

  node src/server.ts            HTTP dashboard + MCP over HTTP (default)
  node src/server.ts --stdio    MCP over stdio for a desktop client
  node src/server.ts --rotate-key
  npm run doctor`);
} else {
  mainHttp(ctx);
}
