/** App-wide state: server snapshot, the running job and its console, toasts and confirmations. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import type { AppStateResponse } from "../../shared/api";
import type { JobEvent, JobInfo, LogLevel } from "../../shared/events";
import { ApiError, JobError, api, cancelJob, followJob, getState } from "../api/client";
import type { JobStarted } from "../../shared/api";

export interface ConsoleLine {
  id: number;
  level: LogLevel | "mark";
  text: string;
}

export interface ConsoleState {
  status: "idle" | "busy" | "ok" | "error";
  title: string;
  sub: string;
  progress: { label: string; done: number; total: number; unit: "files" | "items" | "bytes" } | null;
  jobId: string | null;
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  okLabel?: string;
  danger?: boolean;
}

interface Toast {
  message: string;
  error: boolean;
}

interface RunOptions {
  title: string;
  quiet?: boolean;
}

interface AppContextValue {
  state: AppStateResponse | null;
  setState: (state: AppStateResponse) => void;
  refresh: () => Promise<AppStateResponse>;
  busy: boolean;
  console: ConsoleState;
  lines: ConsoleLine[];
  clearLog: () => void;
  mark: (text: string) => void;
  run: <T>(path: string, body: unknown, options: RunOptions) => Promise<JobInfo & { result: T }>;
  /** Follow a job this page did not start (after a reload, or a backup download). */
  watchActive: () => Promise<void>;
  /** Bumped when a job this page only watched finishes, so views can re-read what it changed. */
  watchedDone: number;
  cancel: () => void;
  toast: (message: string, error?: boolean) => void;
  toastState: Toast | null;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmState: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside AppProvider");
  return value;
}

const MAX_LINES = 2000;

/** `initialState` is for tests; the app loads the state from the server. */
export function AppProvider({ children, initialState = null }: { children: ReactNode; initialState?: AppStateResponse | null }) {
  const [state, setState] = useState<AppStateResponse | null>(initialState);
  const [busy, setBusy] = useState(false);
  const [consoleState, setConsole] = useState<ConsoleState>({ status: "idle", title: "Ready", sub: "", progress: null, jobId: null });
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [toastState, setToast] = useState<Toast | null>(null);
  const [confirmState, setConfirm] = useState<AppContextValue["confirmState"]>(null);
  const [watchedDone, setWatchedDone] = useState(0);
  const nextLine = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);
  /** The job being followed, so the same one is never followed twice. */
  const following = useRef<{ id: string; done: Promise<void> } | null>(null);

  const append = useCallback((level: ConsoleLine["level"], text: string) => {
    setLines((current) => {
      const next = [...current, { id: nextLine.current++, level, text }];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const next = await getState();
    setState(next);
    return next;
  }, []);

  const toast = useCallback((message: string, error = false) => {
    setToast({ message, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 6000 : 3000);
  }, []);

  /** Show a job in the console until it ends. */
  const follow = useCallback(
    async <T,>(id: string, options: RunOptions) => {
      let finished!: () => void;
      following.current = { id, done: new Promise<void>((resolve) => (finished = resolve)) };
      setBusy(true);
      setConsole({ status: "busy", title: options.title, sub: "", progress: null, jobId: id });
      const onEvent = (event: JobEvent) => {
        if (event.type === "log") {
          if (!options.quiet || event.level === "warn" || event.level === "error") append(event.level, event.text);
          if (event.text.trim()) setConsole((current) => ({ ...current, sub: event.text.trim() }));
        } else if (event.type === "progress") {
          setConsole((current) => ({
            ...current,
            progress: { label: event.label, done: event.done, total: event.total, unit: event.unit },
          }));
        }
      };
      try {
        const job = await followJob<T>(id, onEvent);
        const warnings = job.warnings.length;
        const seconds = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
        // The dot shows how it ended; the line says it in words.
        setConsole({
          status: "ok",
          title: options.title,
          sub: warnings ? `Done with ${warnings === 1 ? "1 warning" : `${warnings} warnings`}` : `Done in ${seconds.toFixed(1)}s`,
          progress: null,
          jobId: null,
        });
        return job;
      } catch (error) {
        const message = error instanceof JobError || error instanceof ApiError ? error.message : String(error);
        const cancelled = error instanceof JobError && error.job.status === "cancelled";
        setConsole({
          status: cancelled ? "idle" : "error",
          title: options.title,
          sub: cancelled ? "Cancelled" : `Failed: ${message}`,
          progress: null,
          jobId: null,
        });
        throw error;
      } finally {
        finished();
        if (following.current?.id === id) following.current = null;
        setBusy(false);
      }
    },
    [append],
  );

  const watchActive = useCallback(async () => {
    const current = await getState().catch(() => null);
    const job = current?.activeJob;
    if (!job) return;
    // Already shown (another caller got there first): just wait for it to end.
    if (following.current?.id === job.id) return following.current.done;
    append("mark", job.title);
    try {
      await follow(job.id, { title: job.title });
    } catch {
      // the console already shows how it ended
    }
    setWatchedDone((count) => count + 1);
    await refresh().catch(() => undefined);
  }, [append, follow, refresh]);

  const run = useCallback(
    async <T,>(path: string, body: unknown, options: RunOptions) => {
      // Background reads (quiet) queue behind a task that is already running instead of failing as "busy",
      // e.g. the world read after a reload while an install carries on. User actions are not retried.
      if (options.quiet) await following.current?.done;
      // Busy from the click on, so a double click cannot start the same thing twice.
      const start = () => {
        setBusy(true);
        setConsole({ status: "busy", title: options.title, sub: "", progress: null, jobId: null });
        return api<JobStarted>("POST", path, body);
      };
      let id: string;
      try {
        try {
          ({ job: id } = await start());
        } catch (error) {
          if (!options.quiet || !(error instanceof ApiError) || error.code !== "busy") throw error;
          await watchActive();
          ({ job: id } = await start());
        }
      } catch (error) {
        setBusy(false);
        setConsole({ status: "error", title: options.title, sub: `Failed: ${(error as Error).message}`, progress: null, jobId: null });
        throw error;
      }
      return follow<T>(id, options);
    },
    [follow, watchActive],
  );

  const cancel = useCallback(() => {
    const id = consoleState.jobId;
    if (id) {
      void cancelJob(id);
      return;
    }
    void getState().then((current) => {
      if (current.activeJob) void cancelJob(current.activeJob.id);
    });
  }, [consoleState.jobId]);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ ...options, resolve })), []);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      setState,
      refresh,
      busy,
      console: consoleState,
      lines,
      clearLog: () => setLines([]),
      mark: (text: string) => append("mark", text),
      run,
      watchActive,
      watchedDone,
      cancel,
      toast,
      toastState,
      confirm,
      confirmState: confirmState && {
        ...confirmState,
        resolve: (ok: boolean) => {
          confirmState.resolve(ok);
          setConfirm(null);
        },
      },
    }),
    [state, refresh, busy, consoleState, lines, run, watchActive, watchedDone, cancel, toast, toastState, confirm, confirmState, append],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
