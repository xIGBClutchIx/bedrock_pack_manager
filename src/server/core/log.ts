/** How commands report what they do. The job runner turns this into SSE events; tests collect it. */
import type { LogLevel } from "../../shared/events";

export interface JobLog {
  log(level: LogLevel, text: string): void;
  progress(label: string, done: number, total: number, unit?: "files" | "items" | "bytes"): void;
  /** Warnings collected so far (also logged at "warn"). */
  readonly warnings: string[];
}

export const section = (log: JobLog, text: string) => log.log("section", text);
export const ok = (log: JobLog, text: string) => log.log("ok", text);
export const info = (log: JobLog, text: string) => log.log("info", text);
export const plain = (log: JobLog, text: string) => log.log("plain", text);
export const detail = (log: JobLog, text: string) => log.log("detail", text);
export const fail = (log: JobLog, text: string) => log.log("error", text);
export function warn(log: JobLog, text: string): void {
  log.warnings.push(text);
  log.log("warn", text);
}

/** Collects everything in memory: for tests and for jobs that do not stream. */
export class MemoryLog implements JobLog {
  readonly lines: { level: LogLevel; text: string }[] = [];
  readonly warnings: string[] = [];
  readonly progressEvents: { label: string; done: number; total: number }[] = [];

  log(level: LogLevel, text: string): void {
    this.lines.push({ level, text });
  }

  progress(label: string, done: number, total: number): void {
    this.progressEvents.push({ label, done, total });
  }

  text(): string {
    return this.lines.map((line) => line.text).join("\n");
  }
}
