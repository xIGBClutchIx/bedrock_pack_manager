/** Drop packs in, see exactly what will happen, then install. */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { ROUTES } from "../../shared/api";
import type { DuplicateMode, InstallResult, PlanAction, UploadEntry } from "../../shared/model";
import { deleteUploads, getUploads, uploadFile } from "../api/client";
import { useApp } from "../state/app";
import { Icon, formatBytes, plural, shortPath } from "./common";
import type { WorldContext } from "./Dashboard";

interface Item {
  file: File;
  path: string;
}
/** Bytes sent of the total, and files finished of the count, per dropped item. */
type Progress = Map<string, { done: number; total: number; files: number; filesDone: number }>;

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/;
const LABELS: Record<PlanAction, string> = { upload: "Upload", replace: "Replace", register: "Register", skip: "Skip" };
const UPLOAD_CONCURRENCY = 6;

/** Read a dropped folder (and everything inside) as files with relative paths. */
function walkEntry(entry: FileSystemEntry, prefix = ""): Promise<Item[]> {
  if (entry.isFile) {
    return new Promise((resolve) =>
      (entry as FileSystemFileEntry).file(
        (file) => resolve([{ file, path: prefix + file.name }]),
        () => resolve([]),
      ),
    );
  }
  if (!entry.isDirectory) return Promise.resolve([]);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const readBatch = () =>
      reader.readEntries(
        async (batch) => {
          if (!batch.length) {
            const nested = await Promise.all(children.map((child) => walkEntry(child, `${prefix}${entry.name}/`)));
            resolve(nested.flat());
            return;
          }
          children.push(...batch);
          readBatch();
        },
        () => resolve([]),
      );
    readBatch();
  });
}

export function InstallTab({ ctx }: { ctx: WorldContext }) {
  const { state, setState, run, confirm, toast, refresh, busy, mark } = useApp();
  const uploads = state?.uploads ?? [];
  const root = state?.layout?.serverRoot;
  const [progress, setProgress] = useState<Progress>(new Map());
  const [over, setOver] = useState(false);
  const [mode, setMode] = useState<DuplicateMode>("replace");
  const [reupload, setReupload] = useState(false);
  const [plan, setPlan] = useState<InstallResult | null>(null);
  const [applied, setApplied] = useState<InstallResult | null>(null);
  // The plan needs (re)building; starts true when packs are already waiting (this tab mounts per world).
  const [stale, setStale] = useState(uploads.length > 0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const setUploads = useCallback((next: UploadEntry[]) => state && setState({ ...state, uploads: next }), [state, setState]);

  const preview = useCallback(
    async (quiet = true) => {
      if (!uploads.length) return setPlan(null);
      try {
        const job = await run<InstallResult>(
          ROUTES.install,
          { world: ctx.world, duplicateMode: mode, reupload, dryRun: true },
          { title: "Planning install", quiet },
        );
        setPlan(job.result);
        setApplied(null);
        setStale(false);
      } catch (error) {
        setStale(false); // do not retry in a loop; "Refresh plan" tries again
        toast((error as Error).message, true);
      }
    },
    [uploads.length, run, ctx.world, mode, reupload, toast],
  );

  // Re-plan whenever what will be installed, or how, changes (once the server is free).
  useEffect(() => {
    if (!stale || busy) return;
    const timer = window.setTimeout(() => void preview(), 0);
    return () => window.clearTimeout(timer);
  }, [stale, busy, preview]);

  async function upload(items: Item[]) {
    items = items.filter((item) => !JUNK.test(item.path));
    if (!items.length) return;
    // Progress per top-level item (a file, or a dropped folder), in bytes, so a big archive moves too.
    const tally: Progress = new Map();
    for (const item of items) {
      const top = item.path.split("/")[0]!;
      const entry = tally.get(top) ?? { done: 0, total: 0, files: 0, filesDone: 0 };
      entry.total += item.file.size;
      entry.files++;
      tally.set(top, entry);
    }
    setProgress(new Map(tally));
    const queue = [...items];
    let failed: Error | null = null;
    let lastPaint = 0;
    const paint = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPaint < 100) return;
      lastPaint = now;
      setProgress(new Map([...tally].map(([name, entry]) => [name, { ...entry }])));
    };
    await Promise.all(
      Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
        while (queue.length && !failed) {
          const item = queue.shift()!;
          const entry = tally.get(item.path.split("/")[0]!)!;
          let sent = 0;
          try {
            await uploadFile(item.path, item.file, (bytes) => {
              entry.done += bytes - sent;
              sent = bytes;
              paint();
            });
          } catch (error) {
            failed = error as Error;
            return;
          }
          entry.filesDone++;
          paint(true);
        }
      }),
    );
    setProgress(new Map());
    const { uploads: next } = await getUploads();
    setUploads(next);
    if (failed) return toast(`Upload failed: ${(failed as Error).message}`, true);
    setStale(true);
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    // Entries must be read synchronously, before the first await.
    const entries = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => !!entry);
    const files = [...event.dataTransfer.files];
    if (entries.length) await upload((await Promise.all(entries.map((entry) => walkEntry(entry)))).flat());
    else await upload(files.map((file) => ({ file, path: file.name })));
  }

  async function remove(name?: string) {
    const { uploads: next } = await deleteUploads(name);
    setUploads(next);
    if (next.length) setStale(true);
    else setPlan(null);
  }

  async function install() {
    if (!plan) return;
    const actions = plan.plan.filter((item) => item.action !== "skip").length;
    const warnings = plan.plan
      .filter((item) => item.action !== "skip")
      .flatMap((item) => item.warnings.map((warning) => `${item.name}: ${warning}`));
    const ok = await confirm({
      title: `Install ${plural(actions, "pack")}?`,
      body: (
        <>
          <p>
            Into <b>{ctx.status?.worldName ?? ctx.world}</b> on <code>{state?.label}</code>.
          </p>
          {warnings.length > 0 && (
            <>
              <p>Check these first:</p>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ),
      okLabel: "Install",
    });
    if (!ok) return;
    mark("Installing");
    try {
      const job = await run<InstallResult>(
        ROUTES.install,
        { world: ctx.world, duplicateMode: mode, reupload, dryRun: false },
        { title: `Installing ${plural(actions, "pack")}` },
      );
      setApplied(job.result);
      setPlan(null);
      if (job.result.status) ctx.setStatus(job.result.status);
      await refresh();
      toast(job.result.stats.errors ? "Installed with errors — see the activity log" : "Installed", job.result.stats.errors > 0);
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  const shown = applied ?? plan;
  const counts = { upload: 0, replace: 0, register: 0, skip: 0 } as Record<PlanAction, number>;
  for (const item of shown?.plan ?? []) counts[item.action]++;
  const actionable = (plan?.plan ?? []).filter((item) => item.action !== "skip").length;
  const pending = [...progress.entries()].filter(([name]) => !uploads.some((upload) => upload.name === name));

  return (
    <section className="panel install-grid">
      <div className="stack">
        <div
          className={`dropzone ${over ? "over" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => void onDrop(event)}
        >
          <Icon name="upload" />
          <b>Drop .mcaddon, .mcpack, .zip or pack folders</b>
          <span className="muted small">They are unpacked here first, so only finished packs reach the server.</span>
          <div className="row center tight">
            <button className="btn sm" type="button" onClick={() => fileInput.current?.click()}>
              Choose files
            </button>
            <button className="btn sm" type="button" onClick={() => folderInput.current?.click()}>
              Choose folder
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void upload([...(event.target.files ?? [])].map((file) => ({ file, path: file.name })));
              event.target.value = "";
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: "" }}
            onChange={(event) => {
              void upload([...(event.target.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
              event.target.value = "";
            }}
          />
        </div>

        <ul className="queue">
          {[...uploads.map((u) => [u.name, u] as const), ...pending.map(([name]) => [name, null] as const)].map(([name, entry]) => {
            const p = progress.get(name);
            const percent = p ? Math.round((p.done / Math.max(1, p.total)) * 100) : 100;
            const uploading = !!p && p.filesDone < p.files;
            const meta = uploading
              ? `${formatBytes(p.done)} of ${formatBytes(p.total)}`
              : entry
                ? `${entry.isDir ? `${plural(entry.files, "file")}, ` : ""}${formatBytes(entry.size)}`
                : "";
            return (
              <li key={name}>
                <div className="q-row">
                  <Icon name={entry?.isDir ? "folder" : "upload"} />
                  <span className="q-name" title={name}>
                    {name}
                  </span>
                  <span className="q-meta">{meta}</span>
                  <button className="icon-btn" aria-label={`Remove ${name}`} onClick={() => void remove(name)} disabled={!entry}>
                    <Icon name="close" />
                  </button>
                </div>
                {uploading && (
                  <div className="bar">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="install-options">
          <label className="field">
            When an older version is on the server
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as DuplicateMode);
                setStale(uploads.length > 0);
              }}
            >
              <option value="replace">Replace it</option>
              <option value="skip">Skip the new one</option>
              <option value="keep-both">Keep both</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={reupload}
              onChange={(e) => {
                setReupload(e.target.checked);
                setStale(uploads.length > 0);
              }}
            />
            Upload again when the same version is there
          </label>
        </div>
      </div>

      <div className="plan-card">
        <div className="plan-head">
          <h2>{applied ? "Installed" : "Plan"}</h2>
          <span className="grow" />
          <span className="plan-counts">
            {applied
              ? `${applied.stats.installed} installed, ${applied.stats.skipped} skipped${applied.stats.errors ? `, ${applied.stats.errors} failed` : ""}`
              : (Object.entries(counts) as [PlanAction, number][])
                  .filter(([, n]) => n)
                  .map(([action, n]) => (
                    <span key={action} className={`c-${action}`}>
                      {n} {LABELS[action].toLowerCase()}
                    </span>
                  ))}
          </span>
        </div>
        <div className="plan-list">
          {!shown && (
            <p className="plan-empty">Add packs to see what will be uploaded, replaced or registered. Nothing changes until you install.</p>
          )}
          {shown && shown.plan.length === 0 && (
            <p className="plan-empty">No installable packs were found in what you added. The activity log says why.</p>
          )}
          {shown?.plan.map((item) => (
            <div key={`${item.uuid}:${item.versionLabel}:${item.source}:${item.kind}`} className="plan-item">
              <span className={`action ${item.action}`}>{LABELS[item.action]}</span>
              <div className="names">
                <div className="plan-name" title={`From ${item.source}`}>
                  <b>{item.name}</b>
                  <span className="muted">{item.versionLabel}</span>
                </div>
                <div className="reason">{item.reason}</div>
                {item.warnings.map((warning) => (
                  <div key={warning} className="plan-warning">
                    <Icon name="warn" />
                    <span>{warning}</span>
                  </div>
                ))}
                {item.target && (
                  <div className="target" title={item.target}>
                    To {shortPath(item.target, root)}
                  </div>
                )}
                {item.replaces.map((path) => (
                  <div key={path} className="target" title={path}>
                    Replaces {shortPath(path, root)}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="plan-foot">
          <button className="btn ghost" type="button" onClick={() => void remove()} disabled={busy || !uploads.length}>
            Clear list
          </button>
          <span className="grow" />
          <button className="btn" type="button" onClick={() => void preview(false)} disabled={busy || !uploads.length}>
            Refresh plan
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => void install()}
            disabled={busy || !plan || stale || actionable === 0}
          >
            {actionable ? `Install ${plural(actionable, "pack")}` : "Install"}
          </button>
        </div>
      </div>
    </section>
  );
}
