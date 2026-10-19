/** Typed access to the local server. The token comes from the launch link (?t=...). */
import type { AppStateResponse, JobStarted } from "../../shared/api";
import { ROUTES, TOKEN_HEADER } from "../../shared/api";
import type { JobEvent, JobInfo } from "../../shared/events";
import type { Profile, UploadEntry } from "../../shared/model";

export const TOKEN = new URLSearchParams(window.location.search).get("t") ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const raw = body instanceof Blob || body instanceof ArrayBuffer;
  const response = await fetch(path, {
    method,
    headers: { [TOKEN_HEADER]: TOKEN, ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error ?? `${response.status} ${response.statusText}`, data?.code ?? "error", response.status);
  return data as T;
}

export const getState = () => api<AppStateResponse>("GET", ROUTES.state);
export const getUploads = () => api<{ uploads: UploadEntry[] }>("GET", ROUTES.uploads);
export const deleteUploads = (name?: string) =>
  api<{ uploads: UploadEntry[] }>("DELETE", name ? `${ROUTES.uploads}?name=${encodeURIComponent(name)}` : ROUTES.uploads);
export const uploadFile = (path: string, file: Blob) =>
  api<{ ok: boolean }>("PUT", `${ROUTES.uploads}?path=${encodeURIComponent(path)}`, file, { "Content-Type": "application/octet-stream" });
export const saveProfile = (profile: Profile) => api<{ profiles: Profile[] }>("POST", ROUTES.profiles, profile);
export const deleteProfile = (name: string) =>
  api<{ profiles: Profile[] }>("DELETE", `${ROUTES.profiles}?name=${encodeURIComponent(name)}`);
export const disconnect = () => api<{ ok: boolean }>("POST", ROUTES.disconnect, {});
export const cancelJob = (id: string) => api<{ cancelled: boolean }>("POST", ROUTES.jobCancel(id), {});
export const backupUrl = (world: string | null) =>
  `${ROUTES.backup}?t=${encodeURIComponent(TOKEN)}${world ? `&world=${encodeURIComponent(world)}` : ""}`;

export class JobError extends Error {
  constructor(readonly job: JobInfo) {
    super(job.error ?? "Task failed");
  }
  get code(): string {
    return this.job.errorCode ?? "error";
  }
}

/**
 * Start a job and follow its events until it ends. Resolves with the finished job (result included)
 * or rejects with JobError. EventSource reconnects by itself; `since` makes the server replay what was missed.
 */
export async function runJob<T>(path: string, body: unknown, onEvent: (event: JobEvent) => void): Promise<JobInfo & { result: T }> {
  const { job } = await api<JobStarted>("POST", path, body);
  return new Promise((resolve, reject) => {
    let seen = 0;
    let source: EventSource | null = null;
    const open = () => {
      source = new EventSource(`${ROUTES.jobEvents(job)}?t=${encodeURIComponent(TOKEN)}&since=${seen}`);
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as JobEvent;
        seen = event.seq + 1;
        onEvent(event);
        if (event.type === "end") {
          source?.close();
          if (event.job.status === "done") resolve(event.job as JobInfo & { result: T });
          else reject(new JobError(event.job));
        }
      };
      source.onerror = () => {
        // The stream ends after "end"; any other drop reconnects from where it stopped.
        source?.close();
        setTimeout(open, 500);
      };
    };
    open();
  });
}
