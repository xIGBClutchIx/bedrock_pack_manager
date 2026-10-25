/** The activity bar under the tabs: what is running and how far along, with the full log in a drawer. */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useApp } from "../state/app";
import { Icon, formatBytes } from "./common";

const TAGS: Record<string, string> = { ok: "[OK] ", info: "[INFO] ", warn: "[WARNING] ", error: "[ERROR] " };

const HEIGHT_KEY = "bpm.consoleHeight";
const MIN_HEIGHT = 80;

function savedHeight(): number {
  const value = Number(window.localStorage?.getItem(HEIGHT_KEY));
  return Number.isFinite(value) && value >= MIN_HEIGHT ? value : 220;
}

export function ConsoleDock() {
  const { console: status, lines, clearLog, cancel, busy, toast } = useApp();
  // The log stays out of the way until asked for; the bar always shows what is happening.
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(savedHeight);
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  /** Drag the top edge to resize; the height is remembered for next time. */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const max = Math.max(MIN_HEIGHT, window.innerHeight - 260);
    let latest = startHeight;
    const onMove = (move: PointerEvent) => {
      latest = Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - move.clientY));
      setHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.localStorage?.setItem(HEIGHT_KEY, String(latest));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const nudge = (by: number) =>
    setHeight((current) => {
      const next = Math.max(MIN_HEIGHT, current + by);
      window.localStorage?.setItem(HEIGHT_KEY, String(next));
      return next;
    });

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  const copy = async () => {
    const text = lines.map((line) => `${line.level === "mark" ? "— " : (TAGS[line.level] ?? "")}${line.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("Log copied");
    } catch {
      toast("Could not copy the log", true);
    }
  };
  const progress = status.progress;
  const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <section className={`console ${open ? "open" : ""}`} aria-label="Activity">
      {open && (
        <div className="console-drawer">
          <div
            className="console-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the activity log"
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") nudge(24);
              if (event.key === "ArrowDown") nudge(-24);
            }}
          />
          <div className="console-tools">
            <span className="grow">Activity log</span>
            <button className="btn xs ghost" onClick={() => void copy()} disabled={!lines.length}>
              Copy
            </button>
            <button className="btn xs ghost" onClick={clearLog} disabled={!lines.length}>
              Clear
            </button>
          </div>
          <pre
            ref={logRef}
            role="log"
            aria-live="polite"
            style={{ height }}
            onScroll={(event) => {
              const el = event.currentTarget;
              stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
            }}
          >
            {lines.map((line) =>
              line.level === "mark" ? (
                <div key={line.id} className="log-mark">
                  — {line.text} —
                </div>
              ) : (
                <div key={line.id} className={`log-line ${line.level}`}>
                  {TAGS[line.level] && <span className="tag">{TAGS[line.level]}</span>}
                  {line.text}
                </div>
              ),
            )}
            {!lines.length && <div className="log-empty">Nothing yet. Tasks you run show their progress here.</div>}
          </pre>
        </div>
      )}
      <div className="console-head">
        <span className={`dot ${status.status}`} aria-hidden="true" />
        <b className="console-title">{status.title}</b>
        {progress ? (
          <span className="console-progress" aria-label={`${progress.label} ${progress.done} of ${progress.total}`}>
            <span className="bar">
              <span style={{ width: `${percent}%` }} />
            </span>
            <span className="count-text">
              {progress.unit === "bytes"
                ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
                : `${progress.done} / ${progress.total}`}
            </span>
          </span>
        ) : (
          <span className={`console-sub ${status.status === "error" ? "error" : ""}`} title={status.sub}>
            {status.sub}
          </span>
        )}
        {busy && (
          <button className="btn xs" onClick={cancel}>
            Cancel
          </button>
        )}
        <button className="btn xs ghost log-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide log" : "Show log"}
          <Icon name={open ? "down" : "up"} />
        </button>
      </div>
    </section>
  );
}
