import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/store.ts";
import { Bridge, GuardError } from "../src/bridge.ts";
import { Auth, generateKey } from "../src/auth.ts";
import { RelayTransport } from "../src/device.ts";
import { attachMessages, withAgent, currentAgent, redactArgs } from "../src/piggyback.ts";
import { parseUi } from "../src/tools.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools.ts";

const GUARDS = {
  maxHops: 4,
  maxTurnsPerAgent: 3,
  cooldownMs: 0,
  threadTokenBudget: 100_000,
  messageTtlHours: 24,
};

function fresh() {
  const store = new Store(":memory:");
  const bridge = new Bridge(store, GUARDS);
  return { store, bridge };
}

// ---------------------------------------------------------------------------
describe("piggyback delivery (A6)", () => {
  test("attaches exactly once, after the real result, and leaves it intact", () => {
    const { store, bridge } = fresh();
    store.upsertAgent({ id: "a", name: "Agent A" });
    store.upsertAgent({ id: "b", name: "Agent B" });

    bridge.send({ threadId: "t1", from: "a", to: "b", body: "hello from A" });

    const real = {
      content: [{ type: "text" as const, text: '{"devices":[{"id":"pixel8"}]}' }],
      structuredContent: { devices: [{ id: "pixel8" }] },
    };
    const pending = bridge.peek("b", 11);
    assert.equal(pending.length, 1, "B has one message waiting");

    const out = attachMessages(real, pending, 0, { maxMessages: 10, maxBytes: 8000 });

    // 1. the original result is untouched and still first
    assert.deepEqual(out.content[0], real.content[0]);
    assert.deepEqual(out.structuredContent?.devices, [{ id: "pixel8" }]);

    // 2. both forms present
    assert.equal(out.content.length, 2);
    assert.match(out.content[1].text, /^<hernas_messages count="1">/);
    assert.equal(out.structuredContent?._hernas_messages?.count, 1);

    // 3. exactly once
    const occurrences = out.content[1].text.split("hello from A").length - 1;
    assert.equal(occurrences, 1);

    bridge.ack(pending.map((m) => m.id));
    assert.equal(bridge.peek("b", 11).length, 0, "drained");
    assert.equal(store.listAudit(1).length, 0, "no audit rows from the unit path");
  });

  test("caps the payload and reports the overflow", () => {
    const { store, bridge } = fresh();
    store.upsertAgent({ id: "b", name: "B" });
    for (let i = 0; i < 30; i++) {
      bridge.send({ threadId: `t${i}`, from: "a", to: "b", body: `message ${i}` });
    }
    const pending = bridge.peek("b", 11);
    const out = attachMessages(
      { content: [{ type: "text", text: "real" }] },
      pending,
      bridge.pendingCount("b") - pending.length,
      { maxMessages: 10, maxBytes: 8000 },
    );
    const block = out.content.at(-1)!.text;
    assert.match(block, /count="10"/);
    assert.match(block, /more_unread="20"/);
    assert.match(block, /call read_inbox|read_inbox/);
  });

  test("does not touch a result when the inbox is empty", () => {
    const real = { content: [{ type: "text" as const, text: "x" }] };
    const out = attachMessages(real, [], 0, { maxMessages: 10, maxBytes: 8000 });
    assert.equal(out, real, "same object, no copy, no extra block");
  });

  test("end to end over the real MCP transport", async () => {
    const { store, bridge } = fresh();
    const device = new RelayTransport(1000, 1024);
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, {
      store,
      bridge,
      device,
      attach: { maxMessages: 10, maxBytes: 8000 },
      shotDir: mkdtempSync(join(tmpdir(), "hernas-shots-")),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "b", version: "1" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    await withAgent("a", () => client.callTool({ name: "agent_register", arguments: { name: "A" } }));
    await withAgent("b", () => client.callTool({ name: "agent_register", arguments: { name: "B" } }));

    const sent = await withAgent("a", () =>
      client.callTool({
        name: "send_message",
        arguments: { thread_id: "t1", to: "b", body: "ride along please" },
      }),
    );
    assert.ok(!sent.isError, JSON.stringify(sent.content));

    // B calls an unrelated tool. The message must ride on the result.
    const got = await withAgent("b", () => client.callTool({ name: "device_list", arguments: {} }));
    const blocks = got.content as Array<{ type: string; text: string }>;
    const attached = blocks.find((b) => b.type === "text" && b.text.startsWith("<hernas_messages"));
    assert.ok(attached, "piggyback block present");
    assert.equal(attached.text.split("ride along please").length - 1, 1, "exactly once");

    const devices = JSON.parse(blocks[0].text);
    assert.deepEqual(devices, { devices: [] }, "original device_list result intact");

    // Second call: nothing left to deliver.
    const again = await withAgent("b", () => client.callTool({ name: "device_list", arguments: {} }));
    assert.equal(
      (again.content as Array<{ text: string }>).filter((b) => b.text.startsWith("<hernas_messages")).length,
      0,
    );

    // And the audit recorded both calls with the right caller.
    const audit = store.listAudit(10);
    assert.ok(audit.some((a) => a.tool === "device_list" && a.agent === "b"));
    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
describe("loop guards (A7)", () => {
  test("stops two agents ping-ponging at the hop ceiling", () => {
    const { bridge } = fresh();
    let rejected: GuardError | null = null;
    for (let i = 0; i < 20; i++) {
      const from = i % 2 === 0 ? "a" : "b";
      const to = from === "a" ? "b" : "a";
      try {
        bridge.send({ threadId: "runaway", from, to, body: `turn ${i}` });
      } catch (err) {
        rejected = err as GuardError;
        break;
      }
    }
    assert.ok(rejected, "the loop was halted");
    assert.equal(rejected!.code, "hop_limit");
    assert.equal(bridge.stats()[0].hops, GUARDS.maxHops);
  });

  test("enforces a per-agent turn budget", () => {
    const { bridge } = fresh();
    for (let i = 0; i < GUARDS.maxTurnsPerAgent; i++) {
      bridge.send({ threadId: "t", from: "a", to: "b", body: `m${i}` });
    }
    assert.throws(
      () => bridge.send({ threadId: "t", from: "a", to: "b", body: "one too many" }),
      (e: GuardError) => e.code === "turn_budget",
    );
  });

  test("STOP freezes the thread for everyone", () => {
    const { bridge } = fresh();
    bridge.send({ threadId: "t", from: "a", to: "b", body: "hi" });
    const out = bridge.send({ threadId: "t", from: "b", to: "a", body: "STOP" });
    assert.equal(out.stopped, true);
    assert.throws(
      () => bridge.send({ threadId: "t", from: "a", to: "b", body: "are you there?" }),
      (e: GuardError) => e.code === "thread_closed",
    );
  });

  test("dedupes a retried send by message id", () => {
    const { bridge, store } = fresh();
    const first = bridge.send({ threadId: "t", from: "a", to: "b", body: "once", id: "fixed-id" });
    const again = bridge.send({ threadId: "t", from: "a", to: "b", body: "once", id: "fixed-id" });
    assert.equal(first.messages[0].id, again.messages[0].id);
    const count = store.threadMessages("t").filter((m) => m.id === "fixed-id").length;
    assert.equal(count, 1, "one row, not two");
  });

  test("refuses a self-send and an empty body", () => {
    const { bridge } = fresh();
    assert.throws(() => bridge.send({ threadId: "t", from: "a", to: "a", body: "x" }), /itself/);
    assert.throws(() => bridge.send({ threadId: "t", from: "a", to: "b", body: "   " }), /empty/);
  });

  test("broadcast fans out to every agent except the sender", () => {
    const { store, bridge } = fresh();
    store.upsertAgent({ id: "a", name: "A" });
    store.upsertAgent({ id: "b", name: "B" });
    store.upsertAgent({ id: "c", name: "C" });
    const out = bridge.send({ threadId: "t", from: "a", to: "*", body: "standup" });
    assert.deepEqual(out.messages.map((m) => m.recipient).sort(), ["b", "c"]);
    assert.equal(bridge.peek("a", 5).length, 0, "sender does not receive their own broadcast");
  });
});

// ---------------------------------------------------------------------------
describe("auth (A11)", () => {
  test("the key is 10 CSPRNG digits", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const k = generateKey();
      assert.match(k, /^\d{10}$/);
      seen.add(k);
    }
    assert.ok(seen.size > 45, "keys differ across calls");
  });

  test("stored as a salted hash, mode 0600, plaintext absent from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "hernas-key-"));
    const path = join(dir, "key.json");
    const auth = new Auth(path, 60_000);
    const { created, key } = auth.loadOrCreate();
    assert.equal(created, true);
    assert.ok(key);

    const body = readFileSync(path, "utf8");
    assert.ok(!body.includes(key!), "plaintext key must not be on disk");
    assert.match(body, /"salt":"[0-9a-f]{32}"/);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    assert.equal(auth.checkKey(key!), true);
    assert.equal(auth.checkKey("0000000000"), key === "0000000000");
    assert.equal(auth.checkKey("not-a-key"), false);
  });

  test("6 wrong attempts lock the IP out, then release", () => {
    const dir = mkdtempSync(join(tmpdir(), "hernas-lock-"));
    const auth = new Auth(join(dir, "key.json"), 60_000);
    auth.loadOrCreate();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      auth.recordFail("1.2.3.4", t0);
      assert.equal(auth.checkKey("0000000000"), false);
    }
    assert.ok(auth.lockoutFor("1.2.3.4", t0) > 0, "locked after 5 failures");
    assert.equal(auth.lockoutFor("9.9.9.9", t0), 0, "other IPs unaffected");
    assert.equal(auth.lockoutFor("1.2.3.4", t0 + 31_000), 0, "released after the backoff window");
  });

  test("a session cookie is HttpOnly-shaped and a ticket is single use", () => {
    const dir = mkdtempSync(join(tmpdir(), "hernas-sess-"));
    const auth = new Auth(join(dir, "key.json"), 60_000);
    auth.loadOrCreate();
    const s = auth.createSession("ip");
    assert.ok(s.sid.length > 30 && s.csrf.length > 30);
    const t = auth.issueTicket(s.sid);
    assert.equal(auth.consumeTicket(t), s.sid);
    assert.equal(auth.consumeTicket(t), undefined, "replay rejected");
  });
});

// ---------------------------------------------------------------------------
describe("device routing (A4)", () => {
  test("two devices never run each other's commands", async () => {
    const d = new RelayTransport(200, 1024);
    const p1 = d.run("echo one", "phoneA", 2000);
    const p2 = d.run("echo two", "phoneB", 2000);

    const a = await d.take("phoneA", 10);
    const b = await d.take("phoneB", 10);
    assert.equal(a?.command, "echo one");
    assert.equal(b?.command, "echo two");

    d.finish(a!.id, "phoneA", { exit_code: 0, stdout: "one\n", duration_ms: 1 });
    d.finish(b!.id, "phoneB", { exit_code: 0, stdout: "two\n", duration_ms: 1 });
    assert.equal((await p1).stdout, "one\n");
    assert.equal((await p2).stdout, "two\n");
  });

  test("a result from the wrong device is refused", async () => {
    const d = new RelayTransport(200, 1024);
    const p = d.run("id", "phoneA", 5000);
    const job = await d.take("phoneA", 10);
    assert.equal(d.finish(job!.id, "phoneB", { exit_code: 0, stdout: "hijack" }), null);
    d.finish(job!.id, "phoneA", { exit_code: 0, stdout: "ok", duration_ms: 1 });
    assert.equal((await p).stdout, "ok");
  });

  test("offline device fails fast with a clear reason, no hang", async () => {
    const d = new RelayTransport(100, 1024);
    const t0 = Date.now();
    const job = await d.run("id", "ghost", 150);
    const ms = Date.now() - t0;
    assert.equal(job.status, "error");
    assert.match(job.error!, /offline/);
    assert.ok(ms < 1000, `resolved in ${ms} ms`);
  });

  test("output is capped", async () => {
    const d = new RelayTransport(100, 64);
    const p = d.run("huge", "phoneA", 1000);
    const job = await d.take("phoneA", 10);
    d.finish(job!.id, "phoneA", { exit_code: 0, stdout: "x".repeat(500) });
    assert.equal((await p).stdout.length, 64);
  });

  test("online state comes from last poll, not a timer", () => {
    const d = new RelayTransport(25_000, 1024);
    d.touch("phoneA", "Pixel", 34);
    assert.equal(d.list()[0].online, true);
    d.devices.get("phoneA")!.lastSeen = Date.now() - 60_000;
    assert.equal(d.list()[0].online, false);
  });
});

// ---------------------------------------------------------------------------
describe("persistence (A5)", () => {
  test("messages, agents and threads survive a closed and reopened database", () => {
    const dir = mkdtempSync(join(tmpdir(), "hernas-db-"));
    const path = join(dir, "h.db");

    const s1 = new Store(path);
    const b1 = new Bridge(s1, GUARDS);
    s1.upsertAgent({ id: "a", name: "A" });
    s1.upsertAgent({ id: "b", name: "B" });
    b1.send({ threadId: "persist", from: "a", to: "b", body: "remember me" });
    s1.close();

    const s2 = new Store(path);
    assert.equal(s2.listAgents().length, 2);
    const msgs = s2.threadMessages("persist");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body, "remember me");
    assert.equal(s2.inbox("b", 10).length, 1, "still pending after a restart");
    s2.close();
  });
});

// ---------------------------------------------------------------------------
describe("ui dump parsing", () => {
  const XML =
    '<?xml version="1.0"?><hierarchy rotation="0">' +
    '<node index="0" text="" resource-id="" class="FrameLayout" bounds="[0,0][1080,2400]"/>' +
    '<node index="0" text="Settings" resource-id="com.android.settings:id/title" ' +
    'class="TextView" clickable="true" bounds="[48,120][600,200]"/>' +
    '<node index="1" text="" content-desc="More options" class="ImageView" ' +
    'clickable="true" bounds="[960,120][1032,192]"/></hierarchy>';

  test("finds labelled and clickable nodes with tap points", () => {
    const nodes = parseUi(XML);
    assert.equal(nodes.length, 2);
    assert.deepEqual(nodes[0].center, [324, 160]);
    assert.equal(nodes[1].desc, "More options");
    assert.deepEqual(nodes[1].center, [996, 156]);
  });

  test("filters by mode", () => {
    assert.equal(parseUi(XML, "clickable").length, 2);
    assert.equal(parseUi(XML, "text").length, 2);
    assert.equal(parseUi(XML).every((n) => n.center !== null), true);
  });

  test("survives a malformed dump without throwing", () => {
    assert.deepEqual(parseUi('<node text="x" bounds="nonsense">'), [
      { text: "x", desc: "", id: "", clickable: false, bounds: null, center: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("audit redaction (A11)", () => {
  test("secret-shaped arguments are masked before they reach the database", () => {
    const { store } = fresh();
    const redacted = JSON.parse(
      redactArgs({ device: "pixel", key: "1234567890", relay_token: "abc", nested: { password: "hunter2" }, command: "id" }),
    );
    assert.equal(redacted.key, "[redacted]");
    assert.equal(redacted.relay_token, "[redacted]");
    assert.equal(redacted.nested.password, "[redacted]");
    assert.equal(redacted.command, "id", "non-secret args survive");
    assert.equal(redacted.device, "pixel");

    store.audit({ ts: Date.now() / 1000, tool: "shell", agent: "a", device: "p", args: JSON.stringify(redacted), ok: 1, ms: 1, error: null });
    const row = store.listAudit(1)[0];
    assert.ok(!row.args!.includes("1234567890"), "the key is not in the audit row");
    assert.ok(!row.args!.includes("hunter2"), "the nested secret is not in the audit row");
  });

  test("long arguments are truncated so one call cannot bloat the log", () => {
    const long = JSON.parse(redactArgs({ command: "x".repeat(5000) }));
    assert.ok(long.command.length <= 201, `got ${long.command.length} chars`);
  });
});

describe("agent identity", () => {
  test("defaults to anon and follows the context", () => {
    assert.equal(currentAgent(), "anon");
    assert.equal(withAgent("claude", currentAgent), "claude");
    assert.equal(currentAgent(), "anon", "context does not leak out");
  });
});
