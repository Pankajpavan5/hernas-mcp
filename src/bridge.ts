import { randomUUID } from "node:crypto";
import type { Store, Message, Thread } from "./store.ts";
import type { config as ConfigType } from "./config.ts";

export type BridgeConfig = Pick<
  typeof ConfigType,
  "maxHops" | "maxTurnsPerAgent" | "cooldownMs" | "threadTokenBudget" | "messageTtlHours"
>;

export type SendInput = {
  threadId: string;
  from: string;
  to?: string;
  body: string;
  priority?: "low" | "normal" | "high";
  ttlHours?: number;
  subject?: string;
  id?: string;
  /** The human operator is not an AI turn: skip the loop guards, still count the hop. */
  bypassGuards?: boolean;
};

export class GuardError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GuardError";
    this.code = code;
    this.details = details;
  }
}

/** Rough token estimate: 4 chars per token. Only used to enforce a ceiling, never billed. */
function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

const BROADCAST = new Set(["*", "all", "everyone"]);

export class Bridge {
  store: Store;
  cfg: BridgeConfig;

  constructor(store: Store, cfg: BridgeConfig) {
    this.store = store;
    this.cfg = cfg;
  }

  private guards(thread: Thread, from: string, body: string): void {
    if (thread.state !== "open") {
      throw new GuardError("thread_closed", `thread ${thread.id} is ${thread.state}`, {
        state: thread.state,
      });
    }
    if (thread.hops >= this.cfg.maxHops) {
      throw new GuardError(
        "hop_limit",
        `thread ${thread.id} hit the ${this.cfg.maxHops}-hop ceiling; two agents may not keep replying`,
        { hops: thread.hops, max: this.cfg.maxHops },
      );
    }
    const turns = this.store.countTurns(thread.id, from);
    if (turns >= this.cfg.maxTurnsPerAgent) {
      throw new GuardError(
        "turn_budget",
        `${from} used its ${this.cfg.maxTurnsPerAgent} turns in thread ${thread.id}`,
        { turns, max: this.cfg.maxTurnsPerAgent },
      );
    }
    const since = Date.now() / 1000 - this.store.lastSentAt(thread.id, from);
    if (since * 1000 < this.cfg.cooldownMs) {
      throw new GuardError("cooldown", `wait ${this.cfg.cooldownMs} ms between messages`, {
        retryAfterMs: Math.ceil(this.cfg.cooldownMs - since * 1000),
      });
    }
    if (thread.tokens + estimateTokens(body) > this.cfg.threadTokenBudget) {
      throw new GuardError(
        "token_budget",
        `thread ${thread.id} reached its ${this.cfg.threadTokenBudget}-token ceiling`,
        { tokens: thread.tokens, max: this.cfg.threadTokenBudget },
      );
    }
  }

  private insert(
    thread: Thread,
    from: string,
    to: string,
    body: string,
    priority: string,
    ttlHours: number,
    id: string,
  ): Message {
    const now = Date.now() / 1000;
    const msg: Message = {
      id,
      thread_id: thread.id,
      sender: from,
      recipient: to,
      body,
      priority,
      ttl: ttlHours * 3600,
      created: now,
      hops: thread.hops,
      state: "pending",
      delivered_at: null,
    };
    if (!this.store.insertMessage(msg)) {
      // Same id already stored: a retried send is idempotent, so return what is there.
      return this.store.getMessage(id)!;
    }
    this.store.bumpThread(thread.id, estimateTokens(body));
    return msg;
  }

  send(input: SendInput): { messages: Message[]; stopped: boolean } {
    const thread = this.store.ensureThread(input.threadId, input.subject ?? "");
    const body = String(input.body ?? "");
    if (!body.trim()) throw new GuardError("empty", "body may not be empty");
    if (body.length > 8000) throw new GuardError("too_long", "body over 8000 chars");

    // The global kill switch. "STOP" from any agent freezes the thread for everyone.
    if (body.trim().toUpperCase() === "STOP") {
      this.store.setThreadState(thread.id, "stopped");
      return { messages: [], stopped: true };
    }

    if (input.id) {
      const existing = this.store.getMessage(input.id);
      if (existing) return { messages: [existing], stopped: false };
    }

    const priority = input.priority ?? "normal";
    const ttlHours = input.ttlHours ?? this.cfg.messageTtlHours;
    const to = input.to?.trim() || "*";

    if (BROADCAST.has(to)) {
      const targets = this.store.listAgents().filter((a) => a.id !== input.from);
      if (targets.length === 0) {
        throw new GuardError("no_peers", "no other agent is registered to broadcast to");
      }
      // Every guard is checked once against the thread, then each copy is written.
      if (!input.bypassGuards) this.guards(thread, input.from, body);
      const out = targets.map((a) =>
        this.insert(thread, input.from, a.id, body, priority, ttlHours, randomUUID()),
      );
      return { messages: out, stopped: false };
    }

    if (to === input.from) throw new GuardError("self_send", "an agent may not message itself");
    if (!input.bypassGuards) this.guards(thread, input.from, body);
    return {
      messages: [this.insert(thread, input.from, to, body, priority, ttlHours, input.id ?? randomUUID())],
      stopped: false,
    };
  }

  /** Pending messages for one agent, ready to attach. Not yet marked delivered. */
  peek(agentId: string, limit: number): Message[] {
    return this.store.inbox(agentId, limit);
  }

  /**
   * Mark as delivered. Called only after the tool result has been built, so a crash before the
   * response is written leaves the message pending and it is retried on the next call.
   */
  ack(ids: string[]): void {
    if (ids.length) this.store.markDelivered(ids);
  }

  pendingCount(agentId: string): number {
    return this.store.countPending(agentId);
  }

  endThread(id: string): void {
    this.store.ensureThread(id);
    this.store.setThreadState(id, "ended");
  }

  history(threadId: string, limit = 200): Message[] {
    return this.store.threadMessages(threadId, limit);
  }

  stats() {
    return this.store.listThreads().map((t) => ({
      id: t.id,
      state: t.state,
      hops: t.hops,
      max_hops: this.cfg.maxHops,
      tokens: t.tokens,
      max_tokens: this.cfg.threadTokenBudget,
    }));
  }
}
