/**
 * Background jobs. One runs at a time (they share the server connection). Each job keeps its
 * events so a browser that connects late, or reconnects, gets everything it missed.
 */
import { randomUUID } from "node:crypto";

import type { JobEvent, JobInfo, LogLevel } from "../../shared/events";
import { ERROR_CODES } from "../../shared/events";
import type { JobLog } from "../core/log";
import { CancelledError } from "../storage/errors";

export class BusyError extends Error {
  readonly code = ERROR_CODES.busy;
}

/** An expected failure with a machine-readable code for the UI. */
export class JobFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Listener = (event: JobEvent) => void;

export class Job implements JobLog {
  readonly id = randomUUID().slice(0, 12);
  readonly controller = new AbortController();
  readonly events: JobEvent[] = [];
  readonly warnings: string[] = [];
  readonly startedAt = Date.now();
  status: JobInfo["status"] = "running";
  finishedAt: number | null = null;
  result: unknown;
  error?: string;
  errorCode?: string;
  errorData?: Record<string, unknown>;
  promise!: Promise<unknown>;
  private readonly listeners = new Set<Listener>();
  private lastProgress = 0;

  constructor(
    readonly kind: string,
    readonly title: string,
    private readonly sink?: (level: LogLevel, text: string) => void,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private emit(event: JobEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  log(level: LogLevel, text: string): void {
    this.sink?.(level, text);
    this.emit({ type: "log", seq: this.events.length, level, text });
  }

  progress(label: string, done: number, total: number, unit: "files" | "items" | "bytes" = "files"): void {
    // Throttle to keep the stream light; always send the last one.
    const now = Date.now();
    if (done < total && now - this.lastProgress < 80) return;
    this.lastProgress = now;
    this.emit({ type: "progress", seq: this.events.length, label, done, total, unit });
  }

  info(): JobInfo {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      warnings: [...this.warnings],
      ...(this.status === "running" ? {} : { result: this.result }),
      ...(this.error ? { error: this.error, errorCode: this.errorCode, errorData: this.errorData } : {}),
    };
  }

  finish(): void {
    this.finishedAt = Date.now();
    this.emit({ type: "end", seq: this.events.length, job: this.info() });
    this.listeners.clear();
  }

  /** Replay events after `since`, then follow live ones. Returns an unsubscribe function. */
  subscribe(since: number, listener: Listener): () => void {
    for (const event of this.events.slice(since)) listener(event);
    if (this.status !== "running") return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly order: string[] = [];
  active: Job | null = null;

  constructor(
    private readonly sink?: (level: LogLevel, text: string) => void,
    private readonly keep = 30,
  ) {}

  get busy(): boolean {
    return this.active?.status === "running";
  }

  start(
    kind: string,
    title: string,
    run: (job: Job) => Promise<unknown>,
    mapError: (error: unknown) => JobFailure | null = () => null,
  ): Job {
    if (this.busy) throw new BusyError(`Another task (${this.active!.title}) is still running`);
    const job = new Job(kind, title, this.sink);
    this.sink?.("section", `${title} (job ${job.id})`);
    this.active = job;
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    while (this.order.length > this.keep) this.jobs.delete(this.order.shift()!);

    job.promise = (async () => {
      try {
        job.result = await run(job);
        if (job.signal.aborted) throw new CancelledError();
        job.status = "done";
      } catch (error) {
        if (error instanceof CancelledError || job.signal.aborted) {
          job.status = "cancelled";
          job.error = "Cancelled";
          job.errorCode = ERROR_CODES.cancelled;
        } else {
          const failure = error instanceof JobFailure ? error : mapError(error);
          job.status = "error";
          job.error = failure?.message ?? (error instanceof Error ? error.message : String(error));
          job.errorCode = failure?.code ?? (error instanceof Error ? error.name : "error");
          job.errorData = failure?.data;
          if (!failure) job.log("error", error instanceof Error ? (error.stack ?? error.message) : String(error));
          // A first-time host key is a question for the user, not a failure.
          else job.log(failure.code === ERROR_CODES.unknownHostKey ? "info" : "error", job.error);
        }
      } finally {
        job.finish();
      }
      return job.result;
    })();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.controller.abort();
    return true;
  }
}
