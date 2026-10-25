/** The connected view: sidebar with the server and its worlds, the world's tabs, and the activity bar. */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

import { ROUTES } from "../../shared/api";
import type { ConnectResult, LayoutInfo, LayoutOverrides, WorldStatus, WorldSummary } from "../../shared/model";
import { backupUrl, disconnect } from "../api/client";
import { useApp } from "../state/app";
import { Brand, Icon, Menu, Modal, plural } from "./common";
import { ConsoleDock } from "./ConsoleDock";
import { LayoutFields } from "./ConnectScreen";
import { FolderPicker } from "./FolderPicker";
import { HistoryTab } from "./HistoryTab";
import { InstallTab } from "./InstallTab";
import { PacksTab } from "./PacksTab";
import { ToolsTab } from "./ToolsTab";
import { WorldTab } from "./WorldTab";

export type Tab = "packs" | "install" | "world" | "tools" | "history";
const PROTOCOL_TAGS = { sftp: "SFTP", ftp: "FTP", ftps: "FTPS", "ftps-implicit": "FTPS", local: "Local" } as const;

export interface WorldContext {
  world: string;
  status: WorldStatus | null;
  setStatus: (status: WorldStatus) => void;
  reload: () => Promise<void>;
}

/** A backup is a download the browser runs; follow its job once the server has started it. */
export function useBackupLink() {
  const { busy, watchActive } = useApp();
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (busy) return event.preventDefault();
    window.setTimeout(() => void watchActive(), 400);
  };
}

/** "3 packs", "No packs yet" or "No level.dat": one short line per world. */
function worldLine(summary: WorldSummary): string {
  if (!summary.hasLevelDat) return "No level.dat";
  const packs = (summary.bpCount ?? 0) + (summary.rpCount ?? 0);
  return packs ? plural(packs, "pack") : "No packs yet";
}

/** The connection label without the scheme, which the protocol tag already shows. */
const hostLabel = (label: string | null) => (label ?? "").replace(/^[a-z]+:\/\//, "").replace(/\/$/, "");

export function Dashboard() {
  const { state, refresh, run, toast, busy, watchedDone, confirm } = useApp();
  const [picked, setWorld] = useState<string | null>(null);
  const [statusFor, setStatusFor] = useState<{ world: string; status: WorldStatus } | null>(null);
  const [tab, setTab] = useState<Tab>("packs");
  const [layoutOpen, setLayoutOpen] = useState(false);
  const onBackup = useBackupLink();
  const worlds = useMemo(() => state?.worlds ?? [], [state?.worlds]);

  // The picked world while it exists, else the server's default, else the first one.
  const world = worlds.some((summary) => summary.path === picked) ? picked : (state?.defaultWorld ?? worlds[0]?.path ?? null);
  // A status only counts for the world it was read for.
  const status = statusFor && statusFor.world === world ? statusFor.status : null;
  const setStatus = useCallback((next: WorldStatus) => setStatusFor({ world: next.world, status: next }), []);

  const reload = useCallback(async () => {
    if (!world) return;
    try {
      const job = await run<WorldStatus>(ROUTES.status, { world }, { title: "Reading world", quiet: true });
      setStatus(job.result);
    } catch (error) {
      toast((error as Error).message, true);
    }
  }, [world, run, toast, setStatus]);

  useEffect(() => {
    // Start the read after this render: when the world changes, or after a task this page only watched.
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, watchedDone]);

  const refreshWorlds = async () => {
    if (!world) return;
    const job = await run<WorldStatus>(ROUTES.status, { world, refreshWorlds: true }, { title: "Refreshing", quiet: true }).catch(
      (error) => {
        toast((error as Error).message, true);
        return null;
      },
    );
    if (job) setStatus(job.result);
    await refresh();
  };

  async function leave() {
    const ok = await confirm({ title: "Disconnect?", body: <p>You can reconnect from the saved servers list.</p>, okLabel: "Disconnect" });
    if (!ok) return;
    try {
      await disconnect();
      await refresh();
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  if (!state) return null;
  const settings = state.settings;
  const selected = worlds.find((summary) => summary.path === world);
  const level = status?.level;
  const ctx: WorldContext | null = world ? { world, status, setStatus, reload } : null;
  const tags = [
    selected?.isLevelName ? { text: "Loaded by the server", tone: "accent" } : null,
    level?.exists && !level.error && level.gamemode ? { text: level.gamemode[0]!.toUpperCase() + level.gamemode.slice(1), tone: "" } : null,
    level?.exists && !level.error && level.beta ? { text: "Beta APIs on", tone: "" } : null,
    level && !level.exists ? { text: "No level.dat", tone: "warn" } : null,
  ].filter((tag): tag is { text: string; tone: string } => tag !== null);

  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <div className="server-card conn-chip" title={state.label ?? ""}>
          <span className="proto-tag">{settings ? PROTOCOL_TAGS[settings.protocol] : ""}</span>
          <span className="server-host">{hostLabel(state.label)}</span>
          <Menu
            label="Server options"
            items={[
              { label: "Server folders…", onSelect: () => setLayoutOpen(true), disabled: busy },
              { label: "Rescan worlds", onSelect: () => void refreshWorlds(), disabled: busy },
              { label: "Disconnect", onSelect: () => void leave(), disabled: busy },
            ]}
          />
        </div>

        <nav className="world-nav" aria-label="Worlds">
          <h2 className="side-label">Worlds</h2>
          {worlds.length === 0 && <p className="empty-note">No worlds found. Check the server folders.</p>}
          <div className="world-list">
            {worlds.map((summary) => (
              <button
                key={summary.path}
                className={`world ${summary.path === world ? "active" : ""}`}
                onClick={() => setWorld(summary.path)}
                disabled={busy && summary.path !== world}
                aria-current={summary.path === world}
                title={summary.name}
              >
                <span className="name">{summary.name}</span>
                <span className="sub">{worldLine(summary)}</span>
                {summary.isLevelName && <span className="live-dot" title="Loaded by the server (level-name)" />}
              </button>
            ))}
          </div>
          {/* Phones: the same choice as a compact picker. */}
          {worlds.length > 0 && (
            <select
              className="world-select"
              aria-label="World"
              value={world ?? ""}
              disabled={busy}
              onChange={(e) => setWorld(e.target.value)}
            >
              {worlds.map((summary) => (
                <option key={summary.path} value={summary.path}>
                  {summary.name}
                </option>
              ))}
            </select>
          )}
        </nav>
      </aside>

      <main className="main">
        <header className="world-head">
          <div className="world-title">
            <h1 title={selected?.name}>{selected?.name ?? "No world selected"}</h1>
            {tags.length > 0 && (
              <div className="tags">
                {tags.map((tag) => (
                  <span key={tag.text} className={`tag ${tag.tone}`}>
                    {tag.text}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="head-actions">
            <a className="btn ghost" href={world ? backupUrl(world) : undefined} aria-disabled={!world || busy} onClick={onBackup}>
              <Icon name="download" />
              Backup
            </a>
            <button className="btn primary" onClick={() => setTab("install")} disabled={!world}>
              <Icon name="plus" />
              Add packs
            </button>
          </div>
        </header>

        <nav className="tabs" aria-label="Sections">
          {(
            [
              ["packs", "Packs", status?.packs.length],
              ["install", "Install", state.uploads.length],
              ["world", "World", null],
              ["tools", "Tools", null],
              ["history", "History", null],
            ] as const
          ).map(([id, label, count]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)} aria-current={tab === id}>
              {label}
              {count ? <span className="count">{count}</span> : null}
            </button>
          ))}
        </nav>

        <div className="panels">
          {tab === "history" ? (
            <HistoryTab />
          ) : !ctx ? (
            <p className="empty-note">Pick a world to see its packs.</p>
          ) : tab === "packs" ? (
            // Remount per world so a selection never carries over to another world.
            <PacksTab key={ctx.world} ctx={ctx} />
          ) : tab === "install" ? (
            <InstallTab key={ctx.world} ctx={ctx} />
          ) : tab === "world" ? (
            // Remount when level.dat changes so the controls start from what is on the server.
            <WorldTab
              key={`${ctx.world}:${status?.level.gamemode}:${status?.level.experiments.map((e) => `${e.key}=${e.enabled}`).join()}:${state.layout?.texturepackRequired}`}
              ctx={ctx}
            />
          ) : (
            <ToolsTab ctx={ctx} />
          )}
        </div>

        <ConsoleDock />
      </main>

      {layoutOpen && <LayoutDialog initial={state.overrides} detected={state.layout} onClose={() => setLayoutOpen(false)} />}
    </div>
  );
}

function LayoutDialog({ initial, detected, onClose }: { initial: LayoutOverrides; detected: LayoutInfo | null; onClose: () => void }) {
  const { run, refresh, toast } = useApp();
  const [layout, setLayout] = useState<LayoutOverrides>(initial);
  const [browsing, setBrowsing] = useState<{ key: "serverRoot" | "worldsDir" | "bpDir" | "rpDir"; label: string } | null>(null);
  const apply = async () => {
    onClose();
    try {
      await run<ConnectResult>(ROUTES.layout, { layout }, { title: "Updating server folders" });
      await refresh();
      toast("Server folders updated");
    } catch (error) {
      toast((error as Error).message, true);
    }
  };
  if (browsing) {
    return (
      <FolderPicker
        title={`Pick the ${browsing.label.toLowerCase()}`}
        // Start where the folder is now: the override, else what was detected (full server paths work as paths too).
        start={layout[browsing.key] ?? detected?.[browsing.key] ?? detected?.serverRoot ?? ""}
        onClose={() => setBrowsing(null)}
        onPick={(path) => {
          setLayout((current) => ({ ...current, [browsing.key]: path || undefined }));
          setBrowsing(null);
        }}
      />
    );
  }
  const found = detected && [
    ["Server", detected.serverRoot],
    ["Worlds", detected.singleWorld ?? detected.worldsDir],
    ["Behavior packs", detected.bpDir ?? "Inside the world"],
    ["Resource packs", detected.rpDir ?? "Inside the world"],
  ];
  return (
    <Modal title="Server folders" onClose={onClose}>
      {found && (
        <dl className="found">
          {found.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value ?? ""}>{value ?? "Not found"}</dd>
            </div>
          ))}
        </dl>
      )}
      {detected?.notes.map((note) => (
        <p key={note} className="muted small">
          {note}
        </p>
      ))}
      <h4 className="form-title">Override</h4>
      <p className="muted small">Leave a field empty to keep what was found.</p>
      <div className="grid4">
        <LayoutFields
          layout={layout}
          onChange={(key, value) => setLayout((current) => ({ ...current, [key]: value || undefined }))}
          onBrowse={(key, label) => setBrowsing({ key, label })}
        />
      </div>
      <div className="row end">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void apply()}>
          Apply
        </button>
      </div>
    </Modal>
  );
}
