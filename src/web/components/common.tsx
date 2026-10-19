/** Small shared pieces: icons, the brand mark, modals, confirmations and toasts. */
import { useEffect, useRef, type ReactNode } from "react";

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
};

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {PATHS[name]}
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <span className="logo" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>Bedrock Pack Manager</span>
    </div>
  );
}

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
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>("[data-autofocus], button.primary, button.danger, input, select, button");
    focusable?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);
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
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
