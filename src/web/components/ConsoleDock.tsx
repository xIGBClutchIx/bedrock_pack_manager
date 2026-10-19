/** The activity console docked under the tabs: live job status, progress, and log lines. */
import { useEffect, useRef, useState } from "react";

import { useApp } from "../state/app";

const TAGS: Record<string, string> = { ok: "[OK] ", info: "[INFO] ", warn: "[WARNING] ", error: "[ERROR] " };

export function ConsoleDock() {
  const { console: status, lines, clearLog, cancel, busy, toast } = useApp();
  const [open, setOpen] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

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
    <section className={`console ${open ? "" : "collapsed"}`} aria-label="Activity">
      <div className="console-head">
        <span className={`dot ${status.status === "idle" ? "" : status.status}`} aria-hidden="true" />
        <b>{status.title}</b>
        {progress ? (
          <span className="console-progress" aria-label={`${progress.label} ${progress.done} of ${progress.total}`}>
            <span className={`bar ${percent >= 100 ? "done" : ""}`}>
              <div style={{ width: `${percent}%` }} />
            </span>
            <span>
              {progress.done}/{progress.total}
            </span>
          </span>
        ) : (
          <span className="muted small console-sub">{status.sub}</span>
        )}
        <span className="grow" />
        {busy && (
          <button className="btn xs ghost" onClick={cancel}>
            Cancel
          </button>
        )}
        <button className="btn xs ghost" onClick={() => void copy()}>
          Copy log
        </button>
        <button className="btn xs ghost" onClick={clearLog}>
          Clear
        </button>
        <button className="btn xs ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <pre
          ref={logRef}
          role="log"
          aria-live="polite"
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
        </pre>
      )}
    </section>
  );
}
