/** The connected view: top bar, worlds sidebar, tabs, and the docked console. */
import { useCallback, useEffect, useMemo, useState } from "react";

import { ROUTES } from "../../shared/api";
import type { ConnectResult, LayoutOverrides, WorldStatus } from "../../shared/model";
import { backupUrl, disconnect } from "../api/client";
import { useApp } from "../state/app";
import { Brand, Icon, Modal } from "./common";
import { ConsoleDock } from "./ConsoleDock";
import { LayoutFields } from "./ConnectScreen";
import { InstallTab } from "./InstallTab";
import { PacksTab } from "./PacksTab";
import { ToolsTab } from "./ToolsTab";
import { WorldTab } from "./WorldTab";

export type Tab = "packs" | "install" | "world" | "tools";
const PROTOCOL_TAGS = { sftp: "SFTP", ftp: "FTP", ftps: "FTPS", "ftps-implicit": "FTPS", local: "LOCAL" } as const;

export interface WorldContext {
  world: string;
  status: WorldStatus | null;
  setStatus: (status: WorldStatus) => void;
  reload: () => Promise<void>;
}

export function Dashboard() {
  const { state, refresh, run, toast, busy } = useApp();
  const [picked, setWorld] = useState<string | null>(null);
  const [statusFor, setStatusFor] = useState<{ world: string; status: WorldStatus } | null>(null);
  const [tab, setTab] = useState<Tab>("packs");
  const [layoutOpen, setLayoutOpen] = useState(false);
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
    // Start the read after this render; only when the world changes.
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

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

  if (!state) return null;
  const settings = state.settings;
  const layout = state.layout;
  const selected = worlds.find((summary) => summary.path === world);
  const level = status?.level;
  const registered = (kind: "bp" | "rp") => status?.packs.filter((row) => row.kind === kind && row.registered).length ?? 0;
  const ctx: WorldContext | null = world ? { world, status, setStatus, reload } : null;

  const hidden = [
    ...(status?.hiddenBuiltin ? [`${status.hiddenBuiltin} built-in game pack${status.hiddenBuiltin === 1 ? "" : "s"}`] : []),
    ...(status?.notes ?? []),
  ];

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <div className="conn-chip">
          <span className="dot ok" aria-hidden="true" />
          <span className="proto-tag">{settings ? PROTOCOL_TAGS[settings.protocol] : ""}</span>
          <span className="mono">{state.label}</span>
        </div>
        <span className="grow" />
        <a
          className="btn"
          href={world ? backupUrl(world) : undefined}
          aria-disabled={!world || busy}
          onClick={(event) => (busy || !world) && event.preventDefault()}
        >
          <Icon name="download" />
          Backup
        </a>
        <button
          className="btn ghost"
          disabled={busy}
          onClick={async () => {
            await disconnect();
            await refresh();
          }}
        >
          Disconnect
        </button>
      </header>

      <div className="body">
        <aside className="sidebar">
          <section>
            <div className="side-head">
              <h2 className="eyebrow">Worlds</h2>
              <span className="muted small">{worlds.length || ""}</span>
            </div>
            <div className="world-list">
              {worlds.length === 0 && <p className="empty-note">No worlds found. Use Edit layout… to point at the worlds folder.</p>}
              {worlds.map((summary) => {
                const sub = [
                  summary.bpCount !== null ? `${summary.bpCount} BP` : null,
                  summary.rpCount !== null ? `${summary.rpCount} RP` : null,
                  summary.hasLevelDat ? null : "no level.dat",
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <button
                    key={summary.path}
                    className={`world ${summary.path === world ? "active" : ""}`}
                    onClick={() => !busy && setWorld(summary.path)}
                    aria-current={summary.path === world}
                  >
                    <span className="names">
                      <span className="name">{summary.name}</span>
                      <span className="sub">{sub || "no packs yet"}</span>
                    </span>
                    {summary.isLevelName && (
                      <span className="live" title="level-name in server.properties">
                        LIVE
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
          {layout && (
            <section className="pad">
              <h2 className="eyebrow">Server layout</h2>
              <dl className="layout-dl">
                {layout.singleWorld !== null ? (
                  <div>
                    <dt>World folder</dt>
                    <dd>{layout.singleWorld}</dd>
                  </div>
                ) : (
                  <div>
                    <dt>Worlds</dt>
                    <dd>{layout.worldsDir}</dd>
                  </div>
                )}
                <div>
                  <dt>Behavior packs</dt>
                  <dd>{layout.bpDir ?? "inside the world"}</dd>
                </div>
                <div>
                  <dt>Resource packs</dt>
                  <dd>{layout.rpDir ?? "inside the world"}</dd>
                </div>
                <div>
                  <dt>New packs go to</dt>
                  <dd className="plain">{layout.packScope === "world" ? "The world's own folders" : "Shared server folders"}</dd>
                </div>
                {layout.notes.map((note) => (
                  <div key={note}>
                    <dd className="plain muted">{note}</dd>
                  </div>
                ))}
              </dl>
              <div className="row tight">
                <button className="btn sm ghost" onClick={() => setLayoutOpen(true)} disabled={busy}>
                  Edit layout…
                </button>
                <button className="btn sm ghost" onClick={() => void refreshWorlds()} disabled={busy}>
                  Refresh
                </button>
              </div>
            </section>
          )}
          {hidden.length > 0 && (
            <section className="pad side-bottom">
              <h2 className="eyebrow">Hidden</h2>
              <ul className="hidden-list">
                {hidden.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <main className="content">
          <div className="content-head">
            <div className="title-row">
              <div className="title-block">
                <h1>{selected?.name ?? "No world selected"}</h1>
                <div className="meta">
                  {level?.exists && !level.error && (
                    <span>{level.gamemode ? level.gamemode[0]!.toUpperCase() + level.gamemode.slice(1) : "Gamemode unknown"}</span>
                  )}
                  {level?.exists && !level.error && <span>{level.beta ? "Beta APIs on" : "Beta APIs off"}</span>}
                  {level && !level.exists && <span>No level.dat</span>}
                  {status && (
                    <span>
                      {registered("bp")} behavior · {registered("rp")} resource packs registered
                    </span>
                  )}
                </div>
              </div>
              <span className="grow" />
              <button className="btn primary" onClick={() => setTab("install")} disabled={!world}>
                <Icon name="plus" />
                Add packs
              </button>
            </div>
            <nav className="tabs" aria-label="Sections">
              {(
                [
                  ["packs", "Packs", status?.packs.length],
                  ["install", "Install", state.uploads.length],
                  ["world", "World settings", null],
                  ["tools", "Tools", null],
                ] as const
              ).map(([id, label, count]) => (
                <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)} aria-current={tab === id}>
                  {label}
                  {count ? <span className="count">{count}</span> : null}
                </button>
              ))}
            </nav>
          </div>

          <div className="panels">
            {!ctx ? (
              <p className="empty-note">No world selected.</p>
            ) : tab === "packs" ? (
              <PacksTab ctx={ctx} />
            ) : tab === "install" ? (
              <InstallTab key={ctx.world} ctx={ctx} />
            ) : tab === "world" ? (
              // Remount when level.dat changes so the controls start from what is on the server.
              <WorldTab key={`${ctx.world}:${status?.level.beta}:${status?.level.gamemode}`} ctx={ctx} />
            ) : (
              <ToolsTab ctx={ctx} />
            )}
          </div>

          <ConsoleDock />
        </main>
      </div>

      {layoutOpen && <LayoutDialog initial={state.overrides} onClose={() => setLayoutOpen(false)} />}
    </div>
  );
}

function LayoutDialog({ initial, onClose }: { initial: LayoutOverrides; onClose: () => void }) {
  const { run, refresh, toast } = useApp();
  const [layout, setLayout] = useState<LayoutOverrides>(initial);
  const apply = async () => {
    onClose();
    try {
      await run<ConnectResult>(ROUTES.layout, { layout }, { title: "Updating layout" });
      await refresh();
      toast("Layout updated");
    } catch (error) {
      toast((error as Error).message, true);
    }
  };
  return (
    <Modal title="Server layout" onClose={onClose}>
      <p className="muted small">Leave a field empty to auto-detect it. Paths are relative to the folder you connected to.</p>
      <div className="grid4">
        <LayoutFields layout={layout} onChange={(key, value) => setLayout((current) => ({ ...current, [key]: value || undefined }))} />
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
