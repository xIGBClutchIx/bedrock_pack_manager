/** Pick a folder on the connected server, for layout overrides. */
import { useEffect, useState } from "react";

import type { BrowseResult } from "../../shared/model";
import { browse } from "../api/client";
import { Icon, Modal } from "./common";

export function FolderPicker({
  start,
  title,
  onPick,
  onClose,
}: {
  start: string;
  title: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(start);
  const [listing, setListing] = useState<{ path: string; result: BrowseResult | null; error: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    browse(path).then(
      (result) => live && setListing({ path, result, error: null }),
      (error: Error) => live && setListing({ path, result: null, error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [path]);

  // Only show what was read for the folder now open.
  const current = listing?.path === path ? listing : null;
  const result = current?.result ?? null;
  const join = (name: string) => (path ? `${path.replace(/\/$/, "")}/${name}` : name);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="picker-path">
        <button
          className="btn sm ghost"
          type="button"
          disabled={typeof result?.parent !== "string"}
          onClick={() => setPath(result?.parent ?? "")}
        >
          <Icon name="up" />
          Up
        </button>
        <code>{result?.display ?? (path || "/")}</code>
      </div>
      <ul className="picker-list">
        {!current && <li className="muted">Reading…</li>}
        {current?.error && <li className="banner danger">{current.error}</li>}
        {result && result.dirs.length === 0 && <li className="muted">No folders here</li>}
        {result?.dirs.map((name) => (
          <li key={name}>
            <button type="button" className="picker-item" onClick={() => setPath(join(name))}>
              <Icon name="folder" />
              {name}
            </button>
          </li>
        ))}
      </ul>
      <div className="row end">
        <button className="btn ghost" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" type="button" disabled={!result} onClick={() => onPick(result!.path)}>
          Use this folder
        </button>
      </div>
    </Modal>
  );
}
