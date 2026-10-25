/** Experiments (Beta APIs and others) and default gamemode, written to level.dat; and server-wide settings. */
import { useState } from "react";

import { ROUTES } from "../../shared/api";
import { GAMEMODES, type ConnectResult, type Gamemode, type WorldEditResult } from "../../shared/model";
import { useApp } from "../state/app";
import { Icon } from "./common";
import type { WorldContext } from "./Dashboard";

export function WorldTab({ ctx }: { ctx: WorldContext }) {
  const { state, run, confirm, toast, refresh, busy } = useApp();
  const level = ctx.status?.level;
  const layout = state?.layout;
  // The parent remounts this tab when level.dat or server.properties change, so these start from the server's values.
  const [experiments, setExperiments] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((level?.experiments ?? []).map((experiment) => [experiment.key, experiment.enabled])),
  );
  const [mode, setMode] = useState<Gamemode | null>(level?.gamemode ?? null);
  const [texturepackRequired, setTexturepackRequired] = useState(!!layout?.texturepackRequired);

  if (!level) return <p className="empty-note">Reading the world…</p>;
  const unusable = !level.exists || !!level.error;
  const live = ctx.status?.isLevelName;
  const toggled = Object.fromEntries(
    level.experiments
      .filter((experiment) => experiments[experiment.key] !== experiment.enabled)
      .map((experiment) => [experiment.key, experiments[experiment.key]!]),
  );
  const changed = Object.keys(toggled).length > 0 || (mode !== null && mode !== level.gamemode);

  async function save() {
    const ok = await confirm({
      title: "Change level.dat?",
      body: (
        <p>
          {live ? (
            <>
              <b>This is the world the server loads.</b> Stop the server first, or it overwrites the change when it shuts down.
            </>
          ) : (
            <>
              Make sure the server is <b>stopped</b> if it has this world open.
            </>
          )}{" "}
          The current file is kept as <code>level.dat.backup</code>.
        </p>
      ),
      okLabel: "Save",
    });
    if (!ok) return;
    try {
      const job = await run<WorldEditResult>(
        ROUTES.worldEdit,
        { world: ctx.world, experiments: toggled, gamemode: mode !== level!.gamemode ? mode : null },
        { title: "Saving world settings" },
      );
      ctx.setStatus(job.result.status);
      toast(job.result.changed.length ? "World updated" : "Nothing needed changing");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  async function saveServer() {
    try {
      await run<ConnectResult>(ROUTES.serverProperties, { texturepackRequired }, { title: "Saving server.properties" });
      await refresh();
      toast("server.properties updated - restart the server");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  return (
    <section className="panel narrow">
      <div className={`banner ${live ? "warn" : "info"}`}>
        <Icon name={live ? "warn" : "info"} />
        <span>
          {live
            ? "The server loads this world. Stop it before saving, or it overwrites these settings when it shuts down."
            : "If the server has this world open, stop it before saving."}
        </span>
      </div>
      {unusable ? (
        <div className="banner muted-banner">
          {level.exists ? `Could not read level.dat: ${level.error}` : "This world has no level.dat, so there is nothing to change here."}
        </div>
      ) : (
        <>
          <div className="settings-card">
            <h3 className="card-title">Experiments</h3>
            {level.experiments.map((experiment) => (
              <div className="setting" key={experiment.key}>
                <div className="grow">
                  <b>{experiment.label}</b>
                  <div className="muted small">
                    {experiment.description}
                    {experiment.enabled ? " (on now)" : ""}
                  </div>
                </div>
                <button
                  className="switch"
                  role="switch"
                  aria-checked={!!experiments[experiment.key]}
                  aria-label={experiment.label}
                  disabled={busy}
                  onClick={() => setExperiments((current) => ({ ...current, [experiment.key]: !current[experiment.key] }))}
                >
                  <span />
                </button>
              </div>
            ))}
            <div className="setting">
              <div className="grow">
                <b>Default gamemode</b>
                <div className="muted small">What new players start in</div>
              </div>
              <div className="segmented" role="group" aria-label="Gamemode">
                {GAMEMODES.map((option) => (
                  <button key={option} aria-pressed={mode === option} onClick={() => setMode(option)} disabled={busy}>
                    {option[0]!.toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="row end">
            <button className="btn primary" onClick={() => void save()} disabled={busy || !changed}>
              Save world settings
            </button>
          </div>
        </>
      )}

      {layout?.serverProperties && (
        <>
          <div className="settings-card">
            <h3 className="card-title">Whole server</h3>
            <div className="setting">
              <div className="grow">
                <b>Require resource packs</b>
                <div className="muted small" title={`texturepack-required in ${layout.serverProperties}`}>
                  Players must download the resource packs to join
                </div>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={texturepackRequired}
                aria-label="Require resource packs"
                disabled={busy}
                onClick={() => setTexturepackRequired(!texturepackRequired)}
              >
                <span />
              </button>
            </div>
          </div>
          <div className="row end">
            <button
              className="btn"
              onClick={() => void saveServer()}
              disabled={busy || texturepackRequired === !!layout.texturepackRequired}
            >
              Save server setting
            </button>
          </div>
        </>
      )}
    </section>
  );
}
