import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 7100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcessWithoutNullStreams;
let key = "";
let relay = "";
let cookie = "";
let csrf = "";

/** Run until the boot banner has printed both secrets, or fail loudly. */
function start(): Promise<void> {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [join(HERE, "../src/server.ts")], {
      env: {
        ...process.env,
        HERNAS_PORT: String(PORT),
        HERNAS_HOST: "127.0.0.1",
        HERNAS_DATA: mkdtempSync(join(tmpdir(), "hernas-it-")),
      },
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start. stdout:\n${out}`)), 20_000);
    const check = () => {
      const k = /^\s+(\d{10})\s*$/m.exec(out);
      const t = /relay token (\S+)/.exec(out);
      if (k && t && !key) {
        key = k[1];
        relay = t[1];
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      check();
    });
    proc.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}. stdout:\n${out}`)));
  });
}

/** MCP responses are either JSON or SSE; accept both. */
async function mcp(agent: string, payload: unknown): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-hernas-agent": agent,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : null;
  }
  return text ? JSON.parse(text) : null;
}

async function callTool(agent: string, name: string, args: Record<string, unknown>, id = 2) {
  return mcp(agent, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

async function authed(path: string, opts: RequestInit = {}) {
  return fetch(BASE + path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      cookie,
      "x-hernas-csrf": csrf,
      ...(opts.headers ?? {}),
    },
  });
}

describe("hernas server over HTTP", () => {
  before(async () => {
    await start();
  });

  after(() => {
    proc?.kill("SIGKILL");
  });

  test("healthz answers before auth", async () => {
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });

  test("dashboard HTML is served and is not the MCP endpoint", async () => {
    const r = await fetch(`${BASE}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Hernas/);
    assert.match(html, /id="key"/);
  });

  test("the printed key logs in and yields a CSRF token", async () => {
    assert.match(key, /^\d{10}$/);
    const r = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    csrf = body.csrf;
    const setCookie = r.headers.get("set-cookie")!;
    cookie = setCookie.split(";")[0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.ok(body.csrf.length > 30);
  });

  test("state requires the session cookie", async () => {
    const anonym = await fetch(`${BASE}/api/state`);
    assert.equal(anonym.status, 401);
    const ok = await authed("/api/state");
    assert.equal(ok.status, 200);
    const st = await ok.json();
    assert.ok(Array.isArray(st.devices));
    assert.ok(Array.isArray(st.threads));
  });

  test("a write without the CSRF token is refused", async () => {
    const r = await fetch(`${BASE}/api/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ thread_id: "x" }),
    });
    assert.equal(r.status, 403);
  });

  test("MCP handshake and tool list", async () => {
    const init = await mcp("tester", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tester", version: "1" } },
    });
    assert.equal(init.result.serverInfo.name, "hernas");

    const list = await mcp("tester", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    for (const expected of ["agent_register", "send_message", "read_inbox", "device_list", "shell", "screenshot"]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  test("A sends, B's unrelated tool call carries the message exactly once", async () => {
    await callTool("a", "agent_register", { name: "A" });
    await callTool("b", "agent_register", { name: "B" });

    const sent = await callTool("a", "send_message", {
      thread_id: "e2e",
      to: "b",
      body: "piggyback me",
    });
    assert.ok(!sent.result.isError, JSON.stringify(sent.result.content));

    const got = await callTool("b", "device_list", {});
    const blocks = got.result.content as Array<{ type: string; text: string }>;
    const piggy = blocks.find((x) => x.text.startsWith("<hernas_messages"));
    assert.ok(piggy, "message rode along");
    assert.equal(piggy.text.split("piggyback me").length - 1, 1);
    assert.deepEqual(JSON.parse(blocks[0].text), { devices: [] }, "real result intact");

    const again = await callTool("b", "device_list", {});
    const blocks2 = again.result.content as Array<{ text: string }>;
    assert.equal(blocks2.filter((x) => x.text.startsWith("<hernas_messages")).length, 0);
  });

  test("audit log records the caller and the tool", async () => {
    const r = await authed("/api/state");
    const st = await r.json();
    const entry = st.audit.find((a: { tool: string; agent: string }) => a.tool === "device_list" && a.agent === "b");
    assert.ok(entry, "device_list by b is in the audit");
  });

  test("a real command round trip through a simulated phone", async () => {
    // Kick off a tool call that must block until the phone answers.
    const pending = callTool("a", "shell", { device: "pixel-8", command: "getprop ro.product.model" });

    // The phone polls and gets the job.
    const poll = await fetch(`${BASE}/api/device/poll?device=pixel-8&name=Pixel&sdk=34`, {
      headers: { "x-hernas-relay-token": relayToken() },
    });
    assert.equal(poll.status, 200);
    const job = await poll.json();
    assert.equal(job.command, "getprop ro.product.model");

    // It answers.
    const result = await fetch(`${BASE}/api/device/result`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hernas-relay-token": relayToken() },
      body: JSON.stringify({
        job_id: job.job_id,
        device: "pixel-8",
        exit_code: 0,
        stdout: "Pixel 8\n",
        stderr: "",
        duration_ms: 4,
      }),
    });
    assert.equal(result.status, 200);

    const got = await pending;
    assert.match(got.result.content[0].text, /Pixel 8/);
    assert.match(got.result.content[0].text, /exit 0/);
  });

  test("device_list now shows the phone as online", async () => {
    const r = await callTool("a", "device_list", {});
    const parsed = JSON.parse(r.result.content[0].text);
    assert.equal(parsed.devices[0].id, "pixel-8");
    assert.equal(parsed.devices[0].online, true);
  });

  test("the relay refuses a wrong token", async () => {
    const r = await fetch(`${BASE}/api/device/poll?device=x`, {
      headers: { "x-hernas-relay-token": "nope" },
    });
    assert.equal(r.status, 401);
  });

  // Last on purpose: a lockout also blocks the correct key for its window, so this must not run
  // before the tests that need a session.
  test("six wrong keys lock the IP out, even for the right key", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${BASE}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "0000000000" }),
      });
      last = r.status;
    }
    assert.equal(last, 429, "the sixth attempt is refused by the lockout, not by the key check");

    const withRightKey = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    assert.equal(withRightKey.status, 429, "the lockout is not bypassed by guessing correctly");
    assert.match((await withRightKey.json()).error, /retry in \d+s/);
  });
});

/** The relay token is printed once at boot; the test process captured it there. */
function relayToken(): string {
  if (!relay) throw new Error("relay token was not captured from the boot banner");
  return relay;
}
