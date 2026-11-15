import { randomUUID } from "node:crypto";

export type DeviceRecord = {
  id: string;
  name: string;
  sdk: number | null;
  lastSeen: number;
  online: boolean;
};

export type Job = {
  id: string;
  device: string;
  command: string;
  timeoutMs: number;
  status: "queued" | "running" | "done" | "error";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  created: number;
  started: number | null;
  finished: number | null;
  durationMs: number | null;
  error: string | null;
  by: string;
};

type Waiter = { resolve: (job: Job | null) => void; timer: NodeJS.Timeout };

/**
 * The phone dials out; we never dial in. That is what makes NAT, firewalls and USB irrelevant.
 *
 * Every queue is keyed by a real device id. There is no "*": a command with no device is refused
 * at the tool layer, which is what stops two phones from running each other's work.
 */
export class RelayTransport {
  devices = new Map<string, DeviceRecord>();
  private queues = new Map<string, Job[]>();
  private jobs = new Map<string, Job>();
  private waiters = new Map<string, Waiter[]>();
  private done = new Map<string, (job: Job) => void>();
  private pollHoldMs: number;
  private maxOutput: number;

  constructor(pollHoldMs: number, maxOutput: number) {
    this.pollHoldMs = pollHoldMs;
    this.maxOutput = maxOutput;
  }

  touch(id: string, name?: string, sdk?: number): DeviceRecord {
    const prev = this.devices.get(id);
    const rec: DeviceRecord = {
      id,
      name: name ?? prev?.name ?? "",
      sdk: sdk ?? prev?.sdk ?? null,
      lastSeen: Date.now(),
      online: true,
    };
    this.devices.set(id, rec);
    return rec;
  }

  list(): DeviceRecord[] {
    const cutoff = Date.now() - this.pollHoldMs * 2;
    return [...this.devices.values()]
      .map((d) => ({ ...d, online: d.lastSeen > cutoff }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  isOnline(id: string): boolean {
    const d = this.devices.get(id);
    return !!d && d.lastSeen > Date.now() - this.pollHoldMs * 2;
  }

  /** Queue a command for one device and resolve when that device answers, or the timeout fires. */
  run(command: string, device: string, timeoutMs: number, by = "tool"): Promise<Job> {
    const job: Job = {
      id: randomUUID().slice(0, 12),
      device,
      command,
      timeoutMs,
      status: "queued",
      stdout: "",
      stderr: "",
      exitCode: null,
      created: Date.now(),
      started: null,
      finished: null,
      durationMs: null,
      error: null,
      by,
    };
    this.jobs.set(job.id, job);

    const settled = new Promise<Job>((resolve) => {
      this.done.set(job.id, resolve);
    });

    const queue = this.queues.get(device) ?? [];
    queue.push(job);
    this.queues.set(device, queue);
    this.wake(device);

    const timer = setTimeout(() => {
      if (job.finished === null) {
        job.status = "error";
        job.finished = Date.now();
        job.error = this.isOnline(device)
          ? `device ${device} did not answer within ${timeoutMs} ms`
          : `device ${device} is offline (no poll since ${new Date(this.devices.get(device)?.lastSeen ?? 0).toISOString()})`;
        this.done.get(job.id)?.(job);
        this.done.delete(job.id);
        this.removeFromQueue(job);
      }
    }, timeoutMs);

    return settled.finally(() => {
      clearTimeout(timer);
      this.done.delete(job.id);
    });
  }

  /** Called by the phone's poll: hand it the next job for that device, or hold the call open. */
  take(device: string, holdMs = this.pollHoldMs): Promise<Job | null> {
    this.touch(device);
    const queue = this.queues.get(device);
    if (queue && queue.length > 0) {
      const job = queue.shift()!;
      this.start(job);
      return Promise.resolve(job);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (job) => {
          clearTimeout(waiter.timer);
          const list = this.waiters.get(device) ?? [];
          this.waiters.set(device, list.filter((w) => w !== waiter));
          resolve(job);
        },
        timer: setTimeout(() => waiter.resolve(null), holdMs),
      };
      const list = this.waiters.get(device) ?? [];
      list.push(waiter);
      this.waiters.set(device, list);
    });
  }

  private start(job: Job): void {
    job.status = "running";
    job.started = Date.now();
  }

  private wake(device: string): void {
    const list = this.waiters.get(device);
    if (!list?.length) return;
    const waiter = list[0];
    const queue = this.queues.get(device);
    if (!queue?.length) return;
    const job = queue.shift()!;
    this.start(job);
    waiter.resolve(job);
  }

  private removeFromQueue(job: Job): void {
    const queue = this.queues.get(job.device);
    if (!queue) return;
    this.queues.set(job.device, queue.filter((j) => j.id !== job.id));
  }

  /** The phone's result. Rejected if the job is unknown or belongs to another device. */
  finish(
    jobId: string,
    device: string,
    payload: { exit_code?: number; stdout?: string; stderr?: string; duration_ms?: number },
  ): Job | null {
    const job = this.jobs.get(jobId);
    if (!job || job.device !== device) return null;
    if (job.finished !== null && job.status === "done") return job;

    job.status = "done";
    job.exitCode = typeof payload.exit_code === "number" ? payload.exit_code : null;
    job.stdout = String(payload.stdout ?? "").slice(0, this.maxOutput);
    job.stderr = String(payload.stderr ?? "").slice(0, this.maxOutput);
    job.durationMs = typeof payload.duration_ms === "number" ? payload.duration_ms : null;
    job.finished = Date.now();
    this.touch(device);
    this.done.get(job.id)?.(job);
    this.done.delete(job.id);
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /** Recent jobs, newest first. In memory only: a queued command does not survive a restart. */
  recent(limit = 20): Job[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.created - a.created)
      .slice(0, limit)
      .map((j) => ({ ...j, stdout: j.stdout.slice(0, 500) }));
  }
}
