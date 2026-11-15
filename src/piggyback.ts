import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Bridge } from "./bridge.ts";
import type { Message, Store } from "./store.ts";

/** Who is calling, set by whichever transport accepted the request. */
export const agentContext = new AsyncLocalStorage<{ agentId: string }>();

export function currentAgent(): string {
  return agentContext.getStore()?.agentId ?? "anon";
}

export function withAgent<T>(agentId: string, fn: () => T): T {
  return agentContext.run({ agentId }, fn);
}

const SECRET_KEY = /key|token|secret|password|auth/i;

/** Audit-safe copy of the arguments: secrets masked, long strings cut. */
export function redactArgs(args: unknown): string {
  const walk = (v: unknown, depth = 0): unknown => {
    if (depth > 4) return "[deep]";
    if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}…` : v;
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) ? "[redacted]" : walk(val, depth + 1);
      }
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(walk(args)).slice(0, 2000);
  } catch {
    return "[unserialisable]";
  }
}

export type AttachOptions = { maxMessages: number; maxBytes: number };

/**
 * Append queued messages to a tool result without touching it.
 *
 * The original content blocks keep their order and their exact values; the message block is added
 * after them. Machine-readable copy goes in structuredContent._hernas_messages, human/AI-readable
 * copy goes in a delimited text block, so a client that strips extras still sees one of them.
 */
export function attachMessages(
  result: CallToolResult,
  messages: Message[],
  unread: number,
  opts: AttachOptions,
): CallToolResult {
  if (messages.length === 0) return result;

  const compact = (m: Message) => ({
    id: m.id,
    thread_id: m.thread_id,
    from: m.sender,
    to: m.recipient,
    body: m.body,
    priority: m.priority,
    ts: m.created,
    hops: m.hops,
  });

  let chosen = messages.slice(0, opts.maxMessages);
  let more = unread + (messages.length - chosen.length);

  // Size cap: drop from the end until the JSON payload fits. Never cut a message body.
  const encode = (list: Message[]) =>
    JSON.stringify({ count: list.length, more_unread: more, messages: list.map(compact) });
  while (chosen.length > 0 && encode(chosen).length > opts.maxBytes) {
    chosen = chosen.slice(0, -1);
    more += 1;
  }
  if (chosen.length === 0) return result;

  const payload = encode(chosen);
  // The trailing sentence is outside the tag: clients that parse the block still get clean JSON,
  // and a model reading plain text is told what to do about the remainder.
  const hint = more > 0 ? `\n${more} more unread, call read_inbox.` : "";
  const text =
    `<hernas_messages count="${chosen.length}"` +
    (more > 0 ? ` more_unread="${more}"` : "") +
    `>${payload}</hernas_messages>${hint}`;

  return {
    ...result,
    content: [...result.content, { type: "text", text }],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      _hernas_messages: {
        count: chosen.length,
        more_unread: more,
        messages: chosen.map(compact),
      },
    },
  };
}

export type ToolHandler = (args: never, extra: unknown) => Promise<CallToolResult> | CallToolResult;

export type PiggybackDeps = {
  bridge: Bridge;
  store: Store;
  cap: AttachOptions;
  /** Called after every tool call so the dashboard can push a live update. */
  onActivity?: () => void;
};

/**
 * Wrap one tool handler: run it, then hand its caller anything queued for them.
 *
 * Order matters. The handler finishes first, so its result is complete before any message is
 * attached. Messages are marked delivered only after the result exists - if the process dies
 * before the response goes out, they stay pending and ride on the next call. That makes delivery
 * at-least-once in practice, with client-side dedupe on message id.
 */
export function piggyback<A>(
  deps: PiggybackDeps,
  name: string,
  handler: (args: A, extra: unknown) => Promise<CallToolResult> | CallToolResult,
): (args: A, extra: unknown) => Promise<CallToolResult> {
  return async (args: A, extra: unknown) => {
    const agentId = currentAgent();
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = await handler(args, extra);
    } catch (err) {
      deps.store.audit({
        ts: started / 1000,
        tool: name,
        agent: agentId,
        device: (args as { device?: string })?.device ?? null,
        args: redactArgs(args),
        ok: 0,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
      throw err;
    }

    deps.store.audit({
      ts: started / 1000,
      tool: name,
      agent: agentId,
      device: (args as { device?: string })?.device ?? null,
      args: redactArgs(args),
      ok: result.isError ? 0 : 1,
      ms: Date.now() - started,
      error: null,
    });
    deps.onActivity?.();

    const pending = deps.bridge.peek(agentId, deps.cap.maxMessages + 1);
    if (pending.length === 0) return result;

    const chosen = pending.slice(0, deps.cap.maxMessages);
    const attached = attachMessages(result, chosen, deps.bridge.pendingCount(agentId) - chosen.length, deps.cap);
    deps.bridge.ack(chosen.map((m) => m.id));

    // Best-effort protocol notification for clients that render them. Absence of support is not
    // an error, and it must never turn a good tool result into a failed one.
    const notify = (extra as { sendNotification?: (n: unknown) => Promise<void> })?.sendNotification;
    if (typeof notify === "function") {
      notify({
        method: "notifications/message",
        params: { level: "info", data: { hernas_messages: chosen.length } },
      }).catch(() => {});
    }
    return attached;
  };
}
