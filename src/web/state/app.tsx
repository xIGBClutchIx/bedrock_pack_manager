/** App-wide state: server snapshot, the running job and its console, toasts and confirmations. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import type { AppStateResponse } from "../../shared/api";
import type { JobEvent, JobInfo, LogLevel } from "../../shared/events";
import { ApiError, JobError, cancelJob, getState, runJob as startJob } from "../api/client";

export interface ConsoleLine {
  id: number;
  level: LogLevel | "mark";
  text: string;
}

export interface ConsoleState {
  status: "idle" | "busy" | "ok" | "error";
  title: string;
  sub: string;
  progress: { label: string; done: number; total: number } | null;
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

interface AppContextValue {
  state: AppStateResponse | null;
  setState: (state: AppStateResponse) => void;
  refresh: () => Promise<AppStateResponse>;
  busy: boolean;
  console: ConsoleState;
  lines: ConsoleLine[];
  clearLog: () => void;
  mark: (text: string) => void;
  run: <T>(path: string, body: unknown, options: { title: string; quiet?: boolean }) => Promise<JobInfo & { result: T }>;
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppStateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [consoleState, setConsole] = useState<ConsoleState>({ status: "idle", title: "Idle", sub: "", progress: null, jobId: null });
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [toastState, setToast] = useState<Toast | null>(null);
  const [confirmState, setConfirm] = useState<AppContextValue["confirmState"]>(null);
  const nextLine = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);

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

  const run = useCallback(
    async <T,>(path: string, body: unknown, options: { title: string; quiet?: boolean }) => {
      setBusy(true);
      setConsole({ status: "busy", title: options.title, sub: "", progress: null, jobId: null });
      const onEvent = (event: JobEvent) => {
        if (event.type === "log") {
          if (!options.quiet || event.level === "warn" || event.level === "error") append(event.level, event.text);
          if (event.text.trim()) setConsole((current) => ({ ...current, sub: event.text.trim() }));
        } else if (event.type === "progress") {
          setConsole((current) => ({ ...current, progress: { label: event.label, done: event.done, total: event.total } }));
        }
      };
      try {
        const job = await startJob<T>(path, body, (event) => {
          setConsole((current) => (current.jobId ? current : { ...current, jobId: "pending" }));
          onEvent(event);
        });
        const warnings = job.warnings.length;
        const seconds = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
        setConsole({
          status: "ok",
          title: `${options.title} — done`,
          sub: warnings ? `${warnings} warning(s)` : `${seconds.toFixed(1)}s`,
          progress: null,
          jobId: null,
        });
        return job;
      } catch (error) {
        const message = error instanceof JobError || error instanceof ApiError ? error.message : String(error);
        const cancelled = error instanceof JobError && error.job.status === "cancelled";
        setConsole({
          status: cancelled ? "idle" : "error",
          title: cancelled ? `${options.title} — cancelled` : `${options.title} — failed`,
          sub: message,
          progress: null,
          jobId: null,
        });
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [append],
  );

  const cancel = useCallback(() => {
    void getState().then((current) => {
      if (current.activeJob) void cancelJob(current.activeJob.id);
    });
  }, []);

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
    [state, refresh, busy, consoleState, lines, run, cancel, toast, toastState, confirm, confirmState, append],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
