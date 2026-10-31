/** Job events streamed from the server to the UI over Server-Sent Events. */

export type LogLevel = "section" | "ok" | "info" | "warn" | "error" | "plain" | "detail";

export type JobStatus = "running" | "done" | "error" | "cancelled";

/**
 * `seq` grows with every event; resume with `since = last seq + 1`. Only the latest progress event per label is
 * kept for replay, so a replay may skip seq numbers.
 */
export type JobEvent =
  | { type: "log"; seq: number; level: LogLevel; text: string }
  | { type: "progress"; seq: number; label: string; done: number; total: number; unit: "files" | "items" | "bytes" }
  | { type: "end"; seq: number; job: JobInfo };

export interface JobInfo {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  warnings: string[];
  /** A read-only or background job (world read, dry run). Absent for jobs that change things. */
  quiet?: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  errorData?: Record<string, unknown>;
}

/** Error codes the UI reacts to. */
export const ERROR_CODES = {
  busy: "busy",
  notConnected: "not_connected",
  worldMissing: "world_missing",
  unknownHostKey: "unknown_host_key",
  hostKeyMismatch: "host_key_mismatch",
  connectFailed: "connect_failed",
  noUploads: "no_uploads",
  nothingSelected: "nothing_selected",
  cancelled: "cancelled",
  badRequest: "bad_request",
} as const;

export interface UnknownHostKeyData {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}
