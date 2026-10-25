/** Every pack in the world, with filters, problems, per-pack actions and details. */
import { Fragment, useMemo, useState } from "react";

import { ROUTES } from "../../shared/api";
import type {
  CleanupResult,
  FixNestingResult,
  PackRow,
  PackStatus,
  Problem,
  UninstallResult,
  Version,
  WorldPackChange,
  WorldPacksResult,
} from "../../shared/model";
import { formatVersion } from "../../shared/model";
import { packIconUrl } from "../api/client";
import { useApp } from "../state/app";
import { Icon, Modal, lastPart, plural, shortPath, shortenPaths } from "./common";
import type { WorldContext } from "./Dashboard";

const STATUS_LABELS: Record<PackStatus, string> = {
  ok: "Installed",
  missing: "Missing files",
  "version-mismatch": "Wrong version",
  unregistered: "Not registered",
};
type Filter = PackStatus | "all" | "newer";
const FILTERS: { id: Filter; label: string; tone: string }[] = [
  { id: "all", label: "All", tone: "" },
  { id: "ok", label: "Installed", tone: "ok" },
  { id: "newer", label: "Update available", tone: "info" },
  { id: "version-mismatch", label: "Wrong version", tone: "warn" },
  { id: "missing", label: "Missing", tone: "danger" },
  { id: "unregistered", label: "Not registered", tone: "info" },
];
const DEPENDENCY_LABELS = {
  active: "Active",
  inactive: "On the server, not active",
  missing: "Not installed",
  module: "Built into the game",
} as const;

/** Selection id: the registration key, or the folder for packs that are not registered. */
const rowId = (row: PackRow) => row.key || (row.path ? `path:${row.path}` : "");
const matches = (row: PackRow, filter: Filter) => filter === "all" || (filter === "newer" ? !!row.newerOnServer : row.status === filter);

/** "1.2.0" back into a version list, for the versions the status reports as labels. */
function parseVersion(label: string): Version {
  return label.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** The version this row could switch to: a newer copy, or what the server has when the registered one is missing. */
function switchTarget(row: PackRow): Version | null {
  if (row.newerOnServer) return row.newerOnServer;
  if (row.status === "version-mismatch" && row.onServerVersions.length) return parseVersion(row.onServerVersions.at(-1)!);
  return null;
}

export function PacksTab({ ctx }: { ctx: WorldContext }) {
  const { state, run, confirm, toast, refresh, busy, mark } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [copying, setCopying] = useState<PackRow | null>(null);
  // A few problems are shown straight away; a long list starts folded.
  const [showProblems, setShowProblems] = useState((ctx.status?.problems.length ?? 0) <= 3);
  const rows = useMemo(() => ctx.status?.packs ?? [], [ctx.status]);
  const root = state?.layout?.serverRoot;

  const visible = useMemo(() => {
    const text = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        matches(row, filter) && (!text || `${row.name} ${row.uuid} ${row.paths.join(" ")} ${row.description}`.toLowerCase().includes(text)),
    );
  }, [rows, filter, search]);
  const count = (id: Filter) => rows.filter((row) => matches(row, id)).length;
  const selectable = visible.filter((row) => rowId(row));
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(rowId(row)));
  // Only rows that are on screen in this world count; nothing hidden is ever acted on.
  const chosen = rows.filter((row) => selected.has(rowId(row)));
  const chosenRegistered = chosen.filter((row) => row.registered && row.key);
  const chosenFolders = chosen.filter((row) => !row.registered && row.path);
  const otherWorlds = (state?.worlds ?? []).filter((world) => world.path !== ctx.world);

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function change(changes: WorldPackChange[], title: string) {
    try {
      const job = await run<WorldPacksResult>(ROUTES.worldPacks, { world: ctx.world, changes }, { title });
      ctx.setStatus(job.result.status);
      setSelected(new Set());
      await refresh();
      toast(job.result.applied.length ? job.result.applied.join(" · ") : "Nothing needed changing");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  async function uninstall(keepFiles: boolean, targets = chosenRegistered) {
    const ok = await confirm({
      title: keepFiles ? `Remove ${plural(targets.length, "pack")} from this world?` : `Uninstall ${plural(targets.length, "pack")}?`,
      body: (
        <>
          <ul>
            {targets.map((row) => (
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
        { world: ctx.world, keys: targets.map((row) => row.key), keepFiles },
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

  async function deleteFolders(targets = chosenFolders) {
    try {
      const paths = targets.map((row) => row.path!);
      const preview = await run<CleanupResult>(
        ROUTES.cleanup,
        { world: ctx.world, dryRun: true, paths },
        { title: "Checking folders", quiet: true },
      );
      if (!preview.result.deleted.length)
        return toast(preview.result.kept.length ? "Those folders are still in use - see the activity log" : "Nothing to delete", true);
      const ok = await confirm({
        title: `Delete ${plural(preview.result.deleted.length, "pack folder")}?`,
        body: (
          <>
            <ul>
              {preview.result.deleted.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            {preview.result.kept.length > 0 && (
              <p>{plural(preview.result.kept.length, "folder")} will be kept because a world uses them.</p>
            )}
            <p>This cannot be undone. Take a backup first if you are unsure.</p>
          </>
        ),
        okLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      const job = await run<CleanupResult>(ROUTES.cleanup, { world: ctx.world, dryRun: false, paths }, { title: "Deleting pack folders" });
      if (job.result.status) ctx.setStatus(job.result.status);
      setSelected(new Set());
      await refresh();
      toast(`Deleted ${plural(job.result.deleted.length, "folder")}`);
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

  /** Registered packs of one kind in list order (the first one wins for resource packs). */
  const listOf = (kind: PackRow["kind"]) =>
    rows.filter((other) => other.kind === kind && other.registered).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  /** Move a registered pack one place up or down its list. */
  function move(row: PackRow, by: -1 | 1) {
    const list = listOf(row.kind);
    const at = list.indexOf(row);
    const to = at + by;
    if (at < 0 || to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to]!, list[at]!];
    void change([{ type: "order", kind: row.kind, uuids: list.map((item) => item.uuid) }], "Reordering packs");
  }

  const register = (row: PackRow, version: Version, title: string) =>
    change([{ type: "register", kind: row.kind, uuid: row.uuid, version }], title);

  const problems = ctx.status?.problems ?? [];
  const nestedPaths = new Set(problems.filter((problem) => problem.kind === "nested" && problem.path).map((problem) => problem.path!));
  const actions = { register, uninstall, deleteFolders, move, change, copyTo: setCopying };
  const hidden = [
    ...(ctx.status?.hiddenBuiltin ? [`${plural(ctx.status.hiddenBuiltin, "built-in game pack")} hidden`] : []),
    ...(ctx.status?.notes ?? []).map((note) => shortenPaths(note, root)),
  ];
  return (
    <section className="panel">
      <div className="toolbar">
        <div className="filters" role="group" aria-label="Filter packs">
          {FILTERS.filter((f) => f.id === "all" || count(f.id)).map((f) => (
            <button key={f.id} className={`filter ${f.tone}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              <span className="n">{count(f.id)}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" />
          <span className="sr">Search packs</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search packs" />
        </label>
      </div>

      {problems.length > 0 && (
        <div className="attention">
          <button className="attention-head" aria-expanded={showProblems} onClick={() => setShowProblems(!showProblems)}>
            <Icon name="warn" />
            <span className="grow">{problems.length === 1 ? "1 thing needs attention" : `${problems.length} things need attention`}</span>
            <span className="link-like">{showProblems ? "Hide" : "Show"}</span>
          </button>
          {showProblems && (
            <ul>
              {problems.map((problem) => (
                <li key={`${problem.kind}:${problem.path ?? ""}:${problem.message}`}>
                  <span className="grow">{shortenPaths(problem.message, root)}</span>
                  {problem.fixable && (
                    <button className="btn sm" onClick={() => void fixNesting(problem)} disabled={busy}>
                      Fix
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
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
                  onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...selectable.map(rowId)]) : new Set())}
                />
              </th>
              <th>Pack</th>
              <th className="version-col">Version</th>
              <th className="status-col">Status</th>
              <th className="actions-col">
                <span className="sr">Actions</span>
              </th>
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
                  {rows.length ? "Nothing matches the filter." : "No packs in this world yet. Add packs to install some."}
                </td>
              </tr>
            )}
            {visible.map((row) => {
              const id = rowId(row);
              const key = `${row.kind}:${row.uuid}:${row.versionLabel}:${row.paths[0] ?? ""}`;
              const list = row.registered ? listOf(row.kind) : [];
              return (
                <Fragment key={key}>
                  <PackRowView
                    row={row}
                    selected={!!id && selected.has(id)}
                    expanded={open === key}
                    busy={busy}
                    nested={!!row.path && nestedPaths.has(row.path)}
                    onToggle={(on) => id && toggle(id, on)}
                    onExpand={() => setOpen(open === key ? null : key)}
                    actions={actions}
                  />
                  {open === key && (
                    <PackDetails
                      row={row}
                      busy={busy}
                      root={root}
                      first={list[0] === row}
                      last={list.at(-1) === row}
                      canCopy={otherWorlds.length > 0}
                      actions={actions}
                    />
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {hidden.length > 0 && <p className="list-foot">{hidden.join(". ")}.</p>}

      {chosen.length > 0 && (
        <div className="selection-bar">
          <b>{plural(chosen.length, "pack")} selected</b>
          <span className="grow" />
          <button className="btn ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          {chosenFolders.length > 0 && (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void change(
                    chosenFolders
                      .filter((row) => !nestedPaths.has(row.path!))
                      .map((row) => ({ type: "register", kind: row.kind, uuid: row.uuid, version: row.version })),
                    "Adding packs to the world",
                  )
                }
              >
                Add {chosenFolders.length > 1 ? `${chosenFolders.length} ` : ""}to world
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void deleteFolders()}>
                Delete folder{chosenFolders.length > 1 ? "s" : ""}
              </button>
            </>
          )}
          {chosenRegistered.length > 0 && (
            <>
              <button className="btn" onClick={() => void uninstall(true)} disabled={busy}>
                Remove from world only
              </button>
              <button className="btn danger" onClick={() => void uninstall(false)} disabled={busy}>
                Uninstall &amp; delete files
              </button>
            </>
          )}
        </div>
      )}

      {copying && (
        <CopyToWorlds
          row={copying}
          worlds={otherWorlds.map((world) => ({ path: world.path, name: world.name }))}
          onClose={() => setCopying(null)}
          onCopy={(worlds) => {
            setCopying(null);
            void change(
              [{ type: "register", kind: copying.kind, uuid: copying.uuid, version: copying.version, worlds }],
              "Adding to other worlds",
            );
          }}
        />
      )}
    </section>
  );
}

interface RowActions {
  register: (row: PackRow, version: Version, title: string) => Promise<void>;
  uninstall: (keepFiles: boolean, targets?: PackRow[]) => Promise<void>;
  deleteFolders: (targets?: PackRow[]) => Promise<void>;
  move: (row: PackRow, by: -1 | 1) => void;
  change: (changes: WorldPackChange[], title: string) => Promise<void>;
  copyTo: (row: PackRow) => void;
}

/** The pack's pack_icon.png, or a letter tile when it has none. */
function PackIcon({ row }: { row: PackRow }) {
  const [failed, setFailed] = useState(false);
  if (!row.path || failed)
    return (
      <span className={`pack-icon letter ${row.kind}`} aria-hidden="true">
        {row.name === row.uuid ? "?" : (row.name.trim()[0]?.toUpperCase() ?? "?")}
      </span>
    );
  return <img className="pack-icon" src={packIconUrl(row.path)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function PackRowView({
  row,
  selected,
  expanded,
  busy,
  nested,
  onToggle,
  onExpand,
  actions,
}: {
  row: PackRow;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  /** The folder sits one level too deep; registering it would not help until it is moved. */
  nested: boolean;
  onToggle: (on: boolean) => void;
  onExpand: () => void;
  actions: RowActions;
}) {
  const target = switchTarget(row);
  const unknown = row.name === row.uuid;
  const where =
    row.status === "missing"
      ? "Not on the server"
      : row.status === "version-mismatch"
        ? `Server has ${row.onServerVersions.join(", ")}`
        : `${row.path ? lastPart(row.path) : ""}${row.scope === "world" ? " (in world)" : row.scope === "dev" ? " (development)" : ""}`;
  return (
    <tr className={`${selected ? "selected" : ""} ${expanded ? "expanded" : ""}`}>
      <td className="check">
        {rowId(row) && (
          <input type="checkbox" checked={selected} onChange={(e) => onToggle(e.target.checked)} aria-label={`Select ${row.name}`} />
        )}
      </td>
      <td className="pack-cell">
        <div className="pack-name">
          <PackIcon key={row.path ?? row.uuid} row={row} />
          <span className="names">
            <span className="name-line" title={row.name}>
              {unknown ? "Unknown pack" : row.name}
            </span>
            <span className="sub-line">
              <span className={`kind-text ${row.kind}`}>{row.kind === "bp" ? "Behavior" : "Resource"}</span>
              <span className="where" title={row.paths.join("\n")}>
                {where}
              </span>
            </span>
          </span>
        </div>
      </td>
      <td className="version-col">
        <span className="version">{row.versionLabel}</span>
        {row.newerOnServer && row.status === "ok" && <span className="newer">{formatVersion(row.newerOnServer)} available</span>}
      </td>
      <td className="status-col">
        <span className={`status ${row.status}`}>{STATUS_LABELS[row.status]}</span>
      </td>
      <td className="row-actions">
        {target && (
          <button
            className="btn sm"
            disabled={busy}
            onClick={() => void actions.register(row, target, `Switching to v${formatVersion(target)}`)}
          >
            Use v{formatVersion(target)}
          </button>
        )}
        {row.status === "missing" && row.key && (
          <button className="btn sm" disabled={busy} onClick={() => void actions.uninstall(true, [row])}>
            Drop entry
          </button>
        )}
        {!row.registered && (
          <button
            className="btn sm"
            disabled={busy || nested}
            title={nested ? "Fix the nesting first - the server cannot load it from there" : undefined}
            onClick={() => void actions.register(row, row.version, "Adding to the world")}
          >
            Add to world
          </button>
        )}
        <button
          className={`icon-btn chevron ${expanded ? "open" : ""}`}
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={`Details for ${row.name}`}
        >
          <Icon name="down" />
        </button>
      </td>
    </tr>
  );
}

function PackDetails({
  row,
  busy,
  root,
  first,
  last,
  canCopy,
  actions,
}: {
  row: PackRow;
  busy: boolean;
  root: string | undefined;
  first: boolean;
  last: boolean;
  canCopy: boolean;
  actions: RowActions;
}) {
  const activatable = row.dependencies.filter((dep) => dep.state === "inactive" && dep.uuid && dep.kind && dep.serverVersion);
  return (
    <tr className="details-row">
      <td />
      <td colSpan={4}>
        <div className="pack-details">
          <div>
            <h4>About</h4>
            {row.description ? <p>{row.description}</p> : <p className="muted">No description in the manifest.</p>}
            <dl className="facts">
              {row.authors.length > 0 && (
                <>
                  <dt>By</dt>
                  <dd>{row.authors.join(", ")}</dd>
                </>
              )}
              {row.minEngineVersion && (
                <>
                  <dt>Needs game</dt>
                  <dd>{row.minEngineVersion} or newer</dd>
                </>
              )}
              {row.paths.map((path) => (
                <Fragment key={path}>
                  <dt>Folder</dt>
                  <dd className="mono" title={path}>
                    {shortPath(path, root)}
                  </dd>
                </Fragment>
              ))}
              <dt>UUID</dt>
              <dd className="mono">{row.uuid}</dd>
              {row.registered && row.order !== null && (
                <>
                  <dt>Load order</dt>
                  <dd className="order">
                    <span className="order-pos">{row.order + 1}</span>
                    <span className="order-btns">
                      <button
                        className="btn xs"
                        disabled={busy || first}
                        onClick={() => actions.move(row, -1)}
                        aria-label={`Move ${row.name} up`}
                        title="Higher priority"
                      >
                        <Icon name="up" />
                        Up
                      </button>
                      <button
                        className="btn xs"
                        disabled={busy || last}
                        onClick={() => actions.move(row, 1)}
                        aria-label={`Move ${row.name} down`}
                        title="Lower priority"
                      >
                        <Icon name="down" />
                        Down
                      </button>
                    </span>
                  </dd>
                </>
              )}
            </dl>
            {row.kind === "rp" && row.registered && row.subpacks.length > 0 && (
              <label className="field">
                Subpack
                <select
                  value={row.subpack ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    void actions.change([{ type: "subpack", uuid: row.uuid, subpack: e.target.value || null }], "Picking a subpack")
                  }
                >
                  <option value="">Default</option>
                  {row.subpacks.map((subpack) => (
                    <option key={subpack.folder} value={subpack.folder}>
                      {subpack.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div>
            <h4>Needs</h4>
            {row.dependencies.length === 0 ? (
              <p className="muted">Nothing else.</p>
            ) : (
              <ul className="deps">
                {row.dependencies.map((dep) => (
                  <li key={`${dep.uuid ?? dep.moduleName}`}>
                    <span className="dep-name" title={dep.name}>
                      {dep.name}
                    </span>
                    <span className="dep-version">{dep.versionLabel}</span>
                    <span className={`dep-state ${dep.state} ${dep.tooOld ? "old" : ""}`}>
                      {dep.tooOld ? "Too old" : DEPENDENCY_LABELS[dep.state]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {activatable.length > 0 && (
              <button
                className="btn sm"
                disabled={busy}
                onClick={() =>
                  void actions.change(
                    activatable.map((dep) => ({ type: "register", kind: dep.kind!, uuid: dep.uuid!, version: dep.serverVersion! })),
                    "Activating dependencies",
                  )
                }
              >
                Activate {activatable.length} {activatable.length === 1 ? "dependency" : "dependencies"}
              </button>
            )}
          </div>
          <div>
            <h4>Other worlds</h4>
            {row.usedBy.length === 0 ? (
              <p className="muted">No other world uses it.</p>
            ) : (
              <ul className="deps">
                {row.usedBy.map((use) => (
                  <li key={use.world}>
                    <span className="dep-name" title={use.world}>
                      {use.world}
                    </span>
                    <span className={`dep-version ${use.versionLabel !== row.versionLabel ? "version-note" : ""}`}>{use.versionLabel}</span>
                  </li>
                ))}
              </ul>
            )}
            {canCopy && (
              <button className="btn sm" disabled={busy} onClick={() => actions.copyTo(row)}>
                Add to other worlds…
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function CopyToWorlds({
  row,
  worlds,
  onClose,
  onCopy,
}: {
  row: PackRow;
  worlds: { path: string; name: string }[];
  onClose: () => void;
  onCopy: (worlds: string[]) => void;
}) {
  const using = new Set(row.usedBy.map((use) => use.world));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return (
    <Modal title={`Add ${row.name} to other worlds`} onClose={onClose}>
      <p className="muted small">
        Registers v{row.versionLabel} in each world you pick. The pack folder is shared, so nothing is uploaded.
      </p>
      <ul className="pick-list">
        {worlds.map((world) => (
          <li key={world.path}>
            <label className="check">
              <input
                type="checkbox"
                checked={picked.has(world.path)}
                onChange={(e) =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (e.target.checked) next.add(world.path);
                    else next.delete(world.path);
                    return next;
                  })
                }
              />{" "}
              {world.name}
              {using.has(world.name) && <span className="muted small"> (already uses it)</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="row end">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!picked.size} onClick={() => onCopy([...picked])}>
          Add to {plural(picked.size, "world")}
        </button>
      </div>
    </Modal>
  );
}
