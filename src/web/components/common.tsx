/** Small shared pieces: icons, the brand mark, modals, confirmations and toasts. */
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { useApp } from "../state/app";

const PATHS = {
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  close: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.6" y2="16.6" />
    </>
  ),
  warn: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  check: <polyline points="5 12.5 10 17 19 7" />,
  up: <polyline points="6 15 12 9 18 15" />,
  down: <polyline points="6 9 12 15 18 9" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
};

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {PATHS[name]}
    </svg>
  );
}

/** A small amethyst block: the app's mark. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <svg className="logo" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1 15 4.5 8 8 1 4.5z" fill="#c4adff" />
        <path d="M1 4.5 8 8v7L1 11.5z" fill="#8a6ae0" />
        <path d="M15 4.5 8 8v7l7-3.5z" fill="#6a4fc0" />
      </svg>
      {!compact && <span>Pack Manager</span>}
    </div>
  );
}

/** A button that opens a short list of actions; closes on a pick, Escape, or a click elsewhere. */
export function Menu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : ""}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A server path shown relative to the server folder ("behavior_packs/Good BP"), when it is inside it. */
export function shortPath(path: string, root: string | null | undefined): string {
  if (!root || root === "/" || root === ".") return path;
  const prefix = `${root.replace(/[\\/]+$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The same, for every server path inside a message. */
export function shortenPaths(text: string, root: string | null | undefined): string {
  if (!root || root === "/" || root === ".") return text;
  return text.split(`${root.replace(/[\\/]+$/, "")}/`).join("");
}

/** The last part of a path: the folder name people recognise. */
export const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])";

export function Modal({
  title,
  children,
  onClose,
  labelledBy = "modal-title",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass a fresh onClose on every render; the dialog must not re-run its focus setup for that.
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>("[data-autofocus], button.primary, button.danger, input, select, button");
    focusable?.focus();
    const onKey = (event: KeyboardEvent) => {
      // With dialogs stacked (a confirmation over another dialog), only the top one answers keys.
      const overlays = document.querySelectorAll(".overlay");
      if (overlays[overlays.length - 1] !== ref.current?.parentElement) return;
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !ref.current) return;
      // Keep Tab inside the dialog, wrapping at both ends.
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !item.hasAttribute("disabled"));
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = ref.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <h3 id={labelledBy}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function ConfirmHost() {
  const { confirmState } = useApp();
  if (!confirmState) return null;
  const close = (ok: boolean) => confirmState.resolve(ok);
  return (
    <Modal title={confirmState.title} onClose={() => close(false)}>
      <div className="modal-body">{confirmState.body}</div>
      <div className="row end">
        <button className="btn ghost" onClick={() => close(false)}>
          Cancel
        </button>
        <button className={`btn ${confirmState.danger ? "danger" : "primary"}`} onClick={() => close(true)} data-autofocus>
          {confirmState.okLabel ?? "Continue"}
        </button>
      </div>
    </Modal>
  );
}

export function ToastHost() {
  const { toastState } = useApp();
  if (!toastState) return null;
  return (
    <div id="toast" role="status" className={toastState.error ? "error" : ""}>
      {toastState.message}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** "3 min ago" style times for history lists. */
export function timeAgo(when: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(when).toLocaleString();
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
