/** Every pack in the world, with filters, problems, and uninstall. */
import { useMemo, useState } from "react";

import { ROUTES } from "../../shared/api";
import type { FixNestingResult, PackRow, PackStatus, Problem, UninstallResult } from "../../shared/model";
import { useApp } from "../state/app";
import { Icon, plural } from "./common";
import type { WorldContext } from "./Dashboard";

const STATUS_LABELS: Record<PackStatus, string> = {
  ok: "Installed",
  missing: "Missing files",
  "version-mismatch": "Wrong version",
  unregistered: "Not registered",
};
const FILTERS: { id: PackStatus | "all"; label: string; color: string }[] = [
  { id: "all", label: "All", color: "#c2c9bc" },
  { id: "ok", label: "Installed", color: "#8fd486" },
  { id: "version-mismatch", label: "Wrong version", color: "#f0cf86" },
  { id: "missing", label: "Missing", color: "#f59a8b" },
  { id: "unregistered", label: "Not registered", color: "#8ccaf0" },
];

export function PacksTab({ ctx }: { ctx: WorldContext }) {
  const { run, confirm, toast, refresh, busy, mark } = useApp();
  const [filter, setFilter] = useState<PackStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rows = useMemo(() => ctx.status?.packs ?? [], [ctx.status]);

  const visible = useMemo(() => {
    const text = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (filter === "all" || row.status === filter) &&
        (!text || `${row.name} ${row.uuid} ${row.paths.join(" ")}`.toLowerCase().includes(text)),
    );
  }, [rows, filter, search]);
  const count = (id: PackStatus | "all") => (id === "all" ? rows.length : rows.filter((row) => row.status === id).length);
  const selectable = visible.filter((row) => row.key);
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.key));

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  async function uninstall(keepFiles: boolean) {
    const chosen = rows.filter((row) => selected.has(row.key));
    const ok = await confirm({
      title: keepFiles ? `Remove ${plural(chosen.length, "pack")} from this world?` : `Uninstall ${plural(chosen.length, "pack")}?`,
      body: (
        <>
          <ul>
            {chosen.map((row) => (
              <li key={row.key}>
                {row.name} <span className="muted">v{row.versionLabel}</span>
              </li>
            ))}
          </ul>
          <p>
            {keepFiles
              ? "They are removed from this world's pack lists. Their folders stay on the server."
              : "They are removed from this world, and their folders deleted unless another world still uses them."}
          </p>
        </>
      ),
      okLabel: keepFiles ? "Remove" : "Uninstall",
      danger: !keepFiles,
    });
    if (!ok) return;
    mark(keepFiles ? "Removing from world" : "Uninstalling");
    try {
      const job = await run<UninstallResult>(
        ROUTES.uninstall,
        { world: ctx.world, keys: [...selected], keepFiles },
        { title: keepFiles ? "Removing from world" : "Uninstalling" },
      );
      ctx.setStatus(job.result.status);
      setSelected(new Set());
      await refresh();
      toast("Done");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  async function fixNesting(problem: Problem) {
    try {
      const preview = await run<FixNestingResult>(
        ROUTES.fixNesting,
        { world: ctx.world, paths: problem.path ? [problem.path] : [], dryRun: true },
        { title: "Previewing fix", quiet: true },
      );
      const ok = await confirm({
        title: "Move this pack up a folder?",
        body: (
          <ul>
            {preview.result.moves.map((move) => (
              <li key={move.from}>
                <code>{move.from}</code> → <code>{move.to}</code>
              </li>
            ))}
          </ul>
        ),
        okLabel: "Move it",
      });
      if (!ok) return;
      const job = await run<FixNestingResult>(
        ROUTES.fixNesting,
        { world: ctx.world, paths: problem.path ? [problem.path] : [], dryRun: false },
        { title: "Fixing nested pack" },
      );
      if (job.result.status) ctx.setStatus(job.result.status);
      toast("Moved");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  const problems = ctx.status?.problems ?? [];
  return (
    <section className="panel">
      <div className="toolbar">
        <div className="chips">
          {FILTERS.filter((f) => f.id === "all" || count(f.id)).map((f) => (
            <button
              key={f.id}
              className={`chip-btn ${filter === f.id ? "active" : ""}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              <span className="dot" style={{ background: f.color }} />
              {f.label}
              <span className="n">{count(f.id)}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        <label className="search">
          <Icon name="search" />
          <span className="sr">Search packs</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, UUID or folder" />
        </label>
      </div>

      {problems.length > 0 && (
        <div className="banner warn">
          <Icon name="warn" />
          <div className="grow">
            <b>{plural(problems.length, "thing")} to look at.</b>
            {problems.map((problem) => (
              <div key={problem.message} className="problem-row">
                <span className="grow">{problem.message}</span>
                {problem.fixable && (
                  <button className="btn fix" onClick={() => void fixNesting(problem)} disabled={busy}>
                    Fix
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="table-box">
        <table className="packs">
          <thead>
            <tr>
              <th className="check">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...selectable.map((row) => row.key)]) : new Set())}
                />
              </th>
              <th>Pack</th>
              <th>Version</th>
              <th>Status</th>
              <th>Folder</th>
            </tr>
          </thead>
          <tbody>
            {!ctx.status && (
              <tr>
                <td colSpan={5} className="empty">
                  Reading the world…
                </td>
              </tr>
            )}
            {ctx.status && visible.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {rows.length
                    ? "Nothing matches the filter."
                    : "No packs registered or installed for this world yet. Use Add packs to install some."}
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <PackRowView
                key={`${row.kind}:${row.uuid}:${row.versionLabel}:${row.paths[0] ?? ""}`}
                row={row}
                selected={selected.has(row.key)}
                onToggle={toggle}
              />
            ))}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div className="selection-bar">
          <b>{plural(selected.size, "pack")} selected</b>
          <span className="grow" />
          <button className="btn ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button className="btn" onClick={() => void uninstall(true)} disabled={busy}>
            Remove from world only
          </button>
          <button className="btn danger" onClick={() => void uninstall(false)} disabled={busy}>
            Uninstall &amp; delete files
          </button>
        </div>
      )}
    </section>
  );
}

function PackRowView({ row, selected, onToggle }: { row: PackRow; selected: boolean; onToggle: (key: string, on: boolean) => void }) {
  return (
    <tr className={selected ? "selected" : ""}>
      <td className="check">
        {row.key && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggle(row.key, e.target.checked)}
            aria-label={`Select ${row.name}`}
          />
        )}
      </td>
      <td>
        <div className="pack-name">
          <span className={`kind ${row.kind}`}>{row.kind.toUpperCase()}</span>
          {row.name}
        </div>
        <div className="uuid">{row.uuid}</div>
      </td>
      <td>
        <span className="version">{row.versionLabel}</span>
        {row.status === "version-mismatch" && <div className="version-note">server has {row.onServerVersions.join(", ")}</div>}
      </td>
      <td>
        <span className={`status ${row.status}`}>{STATUS_LABELS[row.status]}</span>
        {row.scope && row.scope !== "shared" && <span className="scope"> ({row.scope === "world" ? "in world" : row.scope})</span>}
      </td>
      <td className="folder">{row.paths.length ? row.paths.map((path) => <div key={path}>{path}</div>) : "—"}</td>
    </tr>
  );
}
