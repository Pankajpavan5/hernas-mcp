import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bridge, GuardError } from "./bridge.ts";
import type { RelayTransport } from "./device.ts";
import type { Store } from "./store.ts";
import { currentAgent, piggyback, type AttachOptions } from "./piggyback.ts";

export type Deps = {
  store: Store;
  bridge: Bridge;
  device: RelayTransport;
  attach: AttachOptions;
  shotDir: string;
  onActivity?: () => void;
};

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 1));
const fail = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

const DEVICE = z
  .string()
  .min(1)
  .describe("Device id from device_list. Required: there is no wildcard, so two phones never share work.");

export function registerTools(server: McpServer, deps: Deps): void {
  const { store, bridge, device } = deps;

  /** Register one tool, routed through the piggyback middleware. */
  function reg<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult> | CallToolResult,
  ): void {
    server.registerTool(name, { description, inputSchema: schema }, (args, extra) =>
      piggyback(
        { bridge, store, cap: deps.attach, onActivity: deps.onActivity },
        name,
        handler as never,
      )(args, extra),
    );
  }

  // ------------------------------------------------------------- agent bridge
  reg(
    "agent_register",
    "Join the bridge. Returns the agent_id to send as the x-hernas-agent header on later calls.",
    {
      name: z.string().min(1).max(40),
      role: z.string().max(80).default("peer"),
      client: z.string().max(40).default("unknown"),
      capabilities: z.array(z.string()).default([]),
    },
    async ({ name, role, client, capabilities }) => {
      const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "anon";
      store.upsertAgent({ id, name, role, client, capabilities: capabilities.join(",") });
      return json({ agent_id: id, name, role, note: "send x-hernas-agent: " + id });
    },
  );

  reg("agent_list", "Who is on the bridge, with role, client, capabilities and online state.", {}, async () => {
    const cutoff = Date.now() / 1000 - 120;
    return json(
      store.listAgents().map((a) => ({
        agent_id: a.id,
        name: a.name,
        role: a.role,
        client: a.client,
        capabilities: a.capabilities ? a.capabilities.split(",") : [],
        online: a.last_seen > cutoff,
        last_seen: Math.round(a.last_seen),
        unread: bridge.pendingCount(a.id),
      })),
    );
  });

  reg(
    "send_message",
    "Send to one agent (or '*' for everyone) in a thread. Loop guards apply: hop ceiling, per-agent turns, cooldown, token budget, and a STOP kill switch.",
    {
      thread_id: z.string().min(1).max(80),
      body: z.string().min(1).max(8000),
      to: z.string().default("*"),
      priority: z.enum(["low", "normal", "high"]).default("normal"),
      subject: z.string().max(120).default(""),
      message_id: z.string().max(80).optional(),
    },
    async (args) => {
      const from = currentAgent();
      if (from === "anon") return fail("Call agent_register first, then send x-hernas-agent on every request.");
      try {
        const out = bridge.send({
          threadId: args.thread_id,
          from,
          to: args.to,
          body: args.body,
          priority: args.priority,
          subject: args.subject,
          id: args.message_id,
        });
        if (out.stopped) return json({ stopped: true, thread_id: args.thread_id, effect: "thread frozen for everyone" });
        return json({
          sent: out.messages.map((m) => ({
            id: m.id,
            to: m.recipient,
            thread_id: m.thread_id,
            hops: m.hops,
            ttl_s: m.ttl,
          })),
        });
      } catch (err) {
        const g = err as GuardError;
        return { content: [{ type: "text", text: `${g.code}: ${g.message}` }], isError: true };
      }
    },
  );

  reg(
    "broadcast",
    "Send one message to every registered agent except yourself.",
    {
      thread_id: z.string().min(1).max(80),
      body: z.string().min(1).max(8000),
      priority: z.enum(["low", "normal", "high"]).default("normal"),
    },
    async (args) => {
      const from = currentAgent();
      if (from === "anon") return fail("Call agent_register first.");
      try {
        const out = bridge.send({
          threadId: args.thread_id,
          from,
          to: "*",
          body: args.body,
          priority: args.priority,
        });
        return json({ delivered_to: out.messages.map((m) => m.recipient) });
      } catch (err) {
        const g = err as GuardError;
        return { content: [{ type: "text", text: `${g.code}: ${g.message}` }], isError: true };
      }
    },
  );

  reg(
    "read_inbox",
    "Fallback for clients that strip attached messages: return queued messages and mark them delivered.",
    {
      limit: z.number().int().min(1).max(50).default(20),
      thread_id: z.string().max(80).optional(),
    },
    async ({ limit, thread_id }) => {
      const me = currentAgent();
      let msgs = bridge.peek(me, limit);
      if (thread_id) msgs = msgs.filter((m) => m.thread_id === thread_id);
      bridge.ack(msgs.map((m) => m.id));
      return json({
        agent_id: me,
        count: msgs.length,
        messages: msgs.map((m) => ({
          id: m.id,
          thread_id: m.thread_id,
          from: m.sender,
          body: m.body,
          priority: m.priority,
          ts: m.created,
          hops: m.hops,
        })),
      });
    },
  );

  reg(
    "end_thread",
    "Close a thread. Further messages to it are refused.",
    { thread_id: z.string().min(1).max(80) },
    async ({ thread_id }) => {
      bridge.endThread(thread_id);
      return json({ thread_id, state: "ended" });
    },
  );

  reg("thread_status", "Hop, turn and token meters for every thread - what the loop guards are counting.", {}, async () =>
    json(bridge.stats()),
  );

  // ------------------------------------------------------------------ devices
  reg(
    "device_list",
    "Phones attached to the relay. Empty means no phone app is polling yet.",
    {},
    async () => json({ devices: device.list() }),
  );

  reg(
    "device_info",
    "Model, Android version, SDK, screen, battery, storage and IP, read live off the phone.",
    { device: DEVICE, timeout_ms: z.number().int().min(1000).max(180_000).default(45_000) },
    async ({ device: id, timeout_ms }) => {
      const script = [
        'echo "manufacturer=$(getprop ro.product.manufacturer)"',
        'echo "model=$(getprop ro.product.model)"',
        'echo "android=$(getprop ro.build.version.release)"',
        'echo "sdk=$(getprop ro.build.version.sdk)"',
        'echo "resolution=$(wm size | tail -1)"',
        'echo "density=$(wm density | tail -1)"',
        'echo "battery=$(dumpsys battery | grep level: | head -1)"',
        'echo "storage=$(df -h /data | tail -1)"',
        'echo "ip=$(ip -f inet addr show wlan0 | grep inet | head -1)"',
      ].join("; ");
      const job = await device.run(script, id, timeout_ms, currentAgent());
      if (job.status !== "done") return fail(jobError(job.status, job.error, id));
      const raw: Record<string, string> = {};
      for (const line of job.stdout.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const size = /(\d{2,5})x(\d{2,5})/.exec(raw.resolution ?? "");
      const level = /(\d+)/.exec(raw.battery ?? "");
      return json({
        device: id,
        ...raw,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        battery_percent: level ? Number(level[1]) : null,
      });
    },
  );

  reg(
    "shell",
    "Run one shell command on one device and return stdout, stderr and exit code. Output is capped at 512 KB.",
    {
      device: DEVICE,
      command: z.string().min(1).max(4000),
      timeout_ms: z.number().int().min(1000).max(180_000).default(60_000),
    },
    async ({ device: id, command, timeout_ms }) => {
      const job = await device.run(command, id, timeout_ms, currentAgent());
      if (job.status !== "done") return fail(jobError(job.status, job.error, id));
      return text(
        `exit ${job.exitCode} (${job.durationMs ?? "?"} ms) on ${id}\n${job.stdout}${job.stderr}`.trimEnd(),
      );
    },
  );

  reg(
    "tap",
    "Tap one screen coordinate.",
    { device: DEVICE, x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000) },
    async ({ device: id, x, y }) => simple(deps, id, `input tap ${x} ${y}`),
  );

  reg(
    "long_press",
    "Press and hold one screen coordinate.",
    {
      device: DEVICE,
      x: z.number().int().min(0).max(20000),
      y: z.number().int().min(0).max(20000),
      ms: z.number().int().min(100).max(10_000).default(1000),
    },
    async ({ device: id, x, y, ms }) => simple(deps, id, `input swipe ${x} ${y} ${x} ${y} ${ms}`),
  );

  reg(
    "swipe",
    "Drag from one coordinate to another.",
    {
      device: DEVICE,
      x1: z.number().int().min(0).max(20000),
      y1: z.number().int().min(0).max(20000),
      x2: z.number().int().min(0).max(20000),
      y2: z.number().int().min(0).max(20000),
      duration_ms: z.number().int().min(1).max(10_000).default(300),
    },
    async ({ device: id, x1, y1, x2, y2, duration_ms }) =>
      simple(deps, id, `input swipe ${x1} ${y1} ${x2} ${y2} ${duration_ms}`),
  );

  reg(
    "type_text",
    "Type into the focused field. ASCII only via `input text`.",
    { device: DEVICE, text: z.string().min(1).max(2000) },
    async ({ device: id, text: value }) => {
      // Single-quote escaping is correct for sh: ' -> '\'' leaves no way to break out.
      const escaped = value.replace(/'/g, `'\\''`);
      return simple(deps, id, `input text '${escaped}'`);
    },
  );

  reg(
    "keyevent",
    "Send an Android key: back, home, recents, enter, del, power, volume_up... or a raw KEYCODE.",
    { device: DEVICE, key: z.string().min(1).max(30) },
    async ({ device: id, key }) => {
      const code = /^\d+$/.test(key) ? key : KEYS[key.toLowerCase()];
      if (!code) return fail(`unknown key ${key}. Try one of: ${Object.keys(KEYS).join(", ")}`);
      return simple(deps, id, `input keyevent ${code}`);
    },
  );

  reg(
    "ui_dump",
    "Read the screen: every text/content-desc element with bounds and a tap point.",
    {
      device: DEVICE,
      only: z.enum(["all", "clickable", "text"]).default("all"),
      limit: z.number().int().min(1).max(500).default(120),
    },
    async ({ device: id, only, limit }) => {
      const job = await device.run(
        `uiautomator dump /data/local/tmp/hernas_ui.xml >/dev/null 2>&1; cat /data/local/tmp/hernas_ui.xml`,
        id,
        90_000,
        currentAgent(),
      );
      if (job.status !== "done") return fail(jobError(job.status, job.error, id));
      const xml = job.stdout.slice(Math.max(0, job.stdout.indexOf("<?xml")));
      if (!xml) return fail(`no UI dump came back (exit ${job.exitCode}): ${job.stdout.slice(0, 300)}`);
      const nodes = parseUi(xml, only).slice(0, limit);
      return json({ device: id, count: nodes.length, elements: nodes });
    },
  );

  reg(
    "screenshot",
    "Grab the screen as a PNG. Returned as an image and saved under shots/.",
    { device: DEVICE, timeout_ms: z.number().int().min(1000).max(180_000).default(90_000) },
    async ({ device: id, timeout_ms }) => {
      const path = "/data/local/tmp/hernas_shot.png";
      const cap = await device.run(`screencap -p ${path}`, id, timeout_ms, currentAgent());
      if (cap.status !== "done" || (cap.exitCode !== 0 && cap.exitCode !== null)) {
        return fail(jobError(cap.status, cap.error, id));
      }
      const stat = await device.run(`stat -c %s ${path}`, id, 30_000, currentAgent());
      const size = Number(/(\d+)/.exec(stat.stdout)?.[1] ?? 0);
      if (!size) return fail(`could not read the screenshot size: ${stat.stdout.slice(0, 200)}`);
      if (size > 8 * 1024 * 1024) return fail(`screenshot is ${size} bytes, over the 8 MB cap`);

      // Chunk so each base64 piece except the last is a multiple of 3 bytes: they then concatenate.
      const chunks = Math.min(20, Math.max(1, Math.ceil(size / 192_000)));
      let bs = Math.max(192_000, Math.ceil(size / chunks));
      bs += (3 - (bs % 3)) % 3;

      const parts: string[] = [];
      for (let i = 0; i < chunks; i++) {
        const got = await device.run(
          `dd if=${path} bs=${bs} skip=${i} count=1 2>/dev/null | base64 | tr -d '\\n'`,
          id,
          timeout_ms,
          currentAgent(),
        );
        if (got.status !== "done" || !got.stdout.trim()) {
          return fail(`chunk ${i + 1}/${chunks} did not come back: ${jobError(got.status, got.error, id)}`);
        }
        parts.push(got.stdout.trim());
      }
      await device.run(`rm -f ${path}`, id, 15_000, currentAgent());

      const b64 = parts.join("");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return fail("the screenshot came back corrupt");

      mkdirSync(deps.shotDir, { recursive: true });
      const shotId = randomUUID().slice(0, 12);
      writeFileSync(join(deps.shotDir, `${shotId}.png`), Buffer.from(b64, "base64"));
      return {
        content: [
          { type: "image", data: b64, mimeType: "image/png" },
          {
            type: "text",
            text: `screenshot ${id}: ${size} on device, ${chunks} chunk(s), saved as shots/${shotId}.png`,
          },
        ],
      };
    },
  );

  async function simple(deps2: Deps, id: string, command: string): Promise<CallToolResult> {
    const job = await deps2.device.run(command, id, 60_000, currentAgent());
    if (job.status !== "done") return fail(jobError(job.status, job.error, id));
    return text(job.exitCode === 0 ? `ok on ${id}` : `exit ${job.exitCode} on ${id}\n${job.stderr}`);
  }
}

/** Distinguish the failure causes instead of one vague "no phone answered". */
function jobError(status: string, error: string | null, deviceId: string): string {
  if (status === "queued") return `device ${deviceId} never polled, so the command is still queued`;
  if (status === "running") return `device ${deviceId} took the command and stopped answering`;
  return error ?? `command failed on ${deviceId}`;
}

const KEYS: Record<string, number> = {
  home: 3, back: 4, call: 5, endcall: 6, dpad_up: 19, dpad_down: 20, dpad_left: 21,
  dpad_right: 22, dpad_center: 23, volume_up: 24, volume_down: 25, power: 26, camera: 27,
  menu: 82, notification: 83, search: 84, play_pause: 85, enter: 66, escape: 111, del: 67,
  tab: 61, space: 62, recents: 187, app_switch: 187, sleep: 223, wakeup: 224,
  copy: 278, cut: 277, paste: 279, all_apps: 284,
};

type UiNode = {
  text: string;
  desc: string;
  id: string;
  clickable: boolean;
  bounds: [number, number, number, number] | null;
  center: [number, number] | null;
};

/** Attribute-level parse: enough for a uiautomator dump, no XML dependency on Android. */
export function parseUi(xml: string, only: "all" | "clickable" | "text" = "all"): UiNode[] {
  const out: UiNode[] = [];
  const nodeRe = /<node\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml))) {
    const attrs = m[1];
    const get = (name: string) => {
      const r = new RegExp(`${name}="([^"]*)"`).exec(attrs);
      return r ? r[1] : "";
    };
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(get("bounds"));
    const bounds = b
      ? ([Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] as [number, number, number, number])
      : null;
    const node: UiNode = {
      text: get("text"),
      desc: get("content-desc"),
      id: get("resource-id"),
      clickable: get("clickable") === "true",
      bounds,
      center: bounds ? [(bounds[0] + bounds[2]) >> 1, (bounds[1] + bounds[3]) >> 1] : null,
    };
    if (!node.text && !node.desc && !node.clickable) continue;
    if (only === "clickable" && !node.clickable) continue;
    if (only === "text" && !node.text && !node.desc) continue;
    out.push(node);
  }
  return out;
}
