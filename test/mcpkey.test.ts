import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 7900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "sekret-42";

let proc: ChildProcessWithoutNullStreams;

function start(): Promise<void> {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [join(HERE, "../src/server.ts")], {
      env: {
        ...process.env,
        HERNAS_PORT: String(PORT),
        HERNAS_HOST: "127.0.0.1",
        HERNAS_MCP_KEY: KEY,
        HERNAS_DATA: mkdtempSync(join(tmpdir(), "hernas-key-")),
      },
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no banner. stdout:\n${out}`)), 20_000);
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (/health/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}. stdout:\n${out}`)));
  });
}

test("HERNAS_MCP_KEY gates /mcp", async () => {
  await start();
  try {
    const call = async (keyHeader?: string) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-hernas-agent": "probe",
      };
      if (keyHeader !== undefined) headers["x-hernas-key"] = keyHeader;
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
        }),
      });
      return res.status;
    };
    assert.equal(await call(), 401, "no key header");
    assert.equal(await call("wrong"), 401, "wrong key");
    assert.equal(await call(KEY), 200, "correct key");
  } finally {
    proc.kill();
  }
});
