/** Typed access to the local server. The token comes from the launch link (?t=...). */
import type { AppStateResponse, JobStarted } from "../../shared/api";
import { ROUTES, TOKEN_HEADER } from "../../shared/api";
import type { JobEvent, JobInfo } from "../../shared/events";
import type { BrowseResult, KnownHost, Profile, UploadEntry } from "../../shared/model";

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

/** A URL the browser opens itself (downloads, images, logs), so the token rides in the query. */
const withToken = (path: string, params: Record<string, string> = {}) =>
  `${path}?${new URLSearchParams({ t: TOKEN, ...params }).toString()}`;

export const getState = () => api<AppStateResponse>("GET", ROUTES.state);
export const getUploads = () => api<{ uploads: UploadEntry[] }>("GET", ROUTES.uploads);
export const deleteUploads = (name?: string) =>
  api<{ uploads: UploadEntry[] }>("DELETE", name ? `${ROUTES.uploads}?name=${encodeURIComponent(name)}` : ROUTES.uploads);
export const saveProfile = (profile: Profile) => api<{ profiles: Profile[] }>("POST", ROUTES.profiles, profile);
export const deleteProfile = (name: string) =>
  api<{ profiles: Profile[] }>("DELETE", `${ROUTES.profiles}?name=${encodeURIComponent(name)}`);
export const disconnect = () => api<{ ok: boolean }>("POST", ROUTES.disconnect, {});
export const cancelJob = (id: string) => api<{ cancelled: boolean }>("POST", ROUTES.jobCancel(id), {});
export const getJobs = () => api<{ jobs: JobInfo[] }>("GET", ROUTES.jobs);
export const getKnownHosts = () => api<{ hosts: KnownHost[] }>("GET", ROUTES.knownHosts);
export const forgetKnownHost = (host: string, port: number) =>
  api<{ removed: number; hosts: KnownHost[] }>("DELETE", `${ROUTES.knownHosts}?${new URLSearchParams({ host, port: String(port) })}`);
export const browse = (path: string) => api<BrowseResult>("GET", `${ROUTES.browse}?path=${encodeURIComponent(path)}`);

export async function getJobLog(id: string): Promise<string> {
  const response = await fetch(ROUTES.jobLog(id), { headers: { [TOKEN_HEADER]: TOKEN } });
  if (!response.ok) throw new ApiError(`${response.status} ${response.statusText}`, "error", response.status);
  return response.text();
}

export const backupUrl = (world: string | null) => withToken(ROUTES.backup, world ? { world } : {});
export const appLogUrl = () => withToken(ROUTES.appLog);
export const packIconUrl = (path: string) => withToken(ROUTES.packIcon, { path });

/** Upload one file, reporting bytes sent. (fetch cannot report upload progress; XHR can.) */
export function uploadFile(path: string, file: Blob, onProgress?: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", `${ROUTES.uploads}?path=${encodeURIComponent(path)}`);
    request.setRequestHeader(TOKEN_HEADER, TOKEN);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => onProgress?.(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(file.size);
        return resolve();
      }
      let data: { error?: string; code?: string } | null = null;
      try {
        data = JSON.parse(request.responseText);
      } catch {
        // not JSON
      }
      reject(new ApiError(data?.error ?? `${request.status} ${request.statusText}`, data?.code ?? "error", request.status));
    };
    request.onerror = () => reject(new ApiError("The upload was interrupted", "error", 0));
    request.send(file);
  });
}

export class JobError extends Error {
  constructor(readonly job: JobInfo) {
    super(job.error ?? "Task failed");
  }
  get code(): string {
    return this.job.errorCode ?? "error";
  }
}

/**
 * Follow a job's events until it ends. Resolves with the finished job (result included) or rejects
 * with JobError. A dropped stream reconnects and `since` replays what was missed; a job the server no
 * longer knows (or a token it no longer accepts, after a restart) ends the wait instead of retrying forever.
 */
export function followJob<T>(id: string, onEvent: (event: JobEvent) => void): Promise<JobInfo & { result: T }> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    let failures = 0;
    let source: EventSource | null = null;
    const open = () => {
      source = new EventSource(`${ROUTES.jobEvents(id)}?t=${encodeURIComponent(TOKEN)}&since=${seen}`);
      source.onmessage = (message) => {
        failures = 0;
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
        source?.close();
        // EventSource hides the status code; ask the job route why the stream stopped.
        api<JobInfo>("GET", ROUTES.job(id)).then(
          (job) => {
            if (job.status !== "running") {
              // It ended while we were away: replay the rest (including "end") from where we stopped.
              open();
            } else {
              setTimeout(open, Math.min(5000, 500 * 2 ** failures++));
            }
          },
          (error: unknown) => {
            if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
              const message =
                error.status === 404
                  ? "Lost track of this task (the app may have restarted). Refresh to see the current state."
                  : error.message;
              reject(
                new JobError({
                  id,
                  kind: "unknown",
                  title: "",
                  status: "error",
                  startedAt: 0,
                  finishedAt: null,
                  warnings: [],
                  error: message,
                  errorCode: error.code,
                }),
              );
            } else {
              setTimeout(open, Math.min(5000, 500 * 2 ** failures++));
            }
          },
        );
      };
    };
    open();
  });
}

/** Start a job and follow it (see followJob). */
export async function runJob<T>(path: string, body: unknown, onEvent: (event: JobEvent) => void): Promise<JobInfo & { result: T }> {
  const { job } = await api<JobStarted>("POST", path, body);
  return followJob<T>(job, onEvent);
}
