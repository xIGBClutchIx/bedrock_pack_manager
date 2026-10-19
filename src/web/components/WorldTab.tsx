/** Beta APIs and default gamemode, written to level.dat. */
import { useState } from "react";

import { ROUTES } from "../../shared/api";
import { GAMEMODES, type Gamemode, type WorldEditResult } from "../../shared/model";
import { useApp } from "../state/app";
import { Icon } from "./common";
import type { WorldContext } from "./Dashboard";

export function WorldTab({ ctx }: { ctx: WorldContext }) {
  const { run, confirm, toast, busy } = useApp();
  const level = ctx.status?.level;
  // The parent remounts this tab when level.dat changes, so these start from the server's values.
  const [beta, setBeta] = useState<boolean>(!!level?.beta);
  const [mode, setMode] = useState<Gamemode | null>(level?.gamemode ?? null);

  if (!level) return <p className="empty-note">Reading the world…</p>;
  const unusable = !level.exists || !!level.error;
  const changed = (beta && !level.beta) || (mode !== null && mode !== level.gamemode);

  async function save() {
    const ok = await confirm({
      title: "Change level.dat?",
      body: (
        <p>
          Make sure the server is <b>stopped</b>, otherwise it may overwrite the change. The current file is kept as{" "}
          <code>level.dat.backup</code>.
        </p>
      ),
      okLabel: "Save",
    });
    if (!ok) return;
    try {
      const job = await run<WorldEditResult>(
        ROUTES.worldEdit,
        { world: ctx.world, beta: beta && !level!.beta, gamemode: mode !== level!.gamemode ? mode : null },
        { title: "Saving world settings" },
      );
      ctx.setStatus(job.result.status);
      toast("World updated");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  return (
    <section className="panel narrow">
      <div className="banner warn">
        <Icon name="info" />
        Stop the server first — a running server overwrites level.dat when it shuts down. A backup is saved as level.dat.backup.
      </div>
      {unusable ? (
        <div className="banner muted-banner">
          {level.exists ? `Could not read level.dat: ${level.error}` : "This world has no level.dat, so there is nothing to change here."}
        </div>
      ) : (
        <>
          <div className="settings-card">
            <div className="setting">
              <div className="grow">
                <b>Beta APIs</b>
                <div className="muted small">Turns on the experiments script add-ons need{level.beta ? " (already on)" : ""}</div>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={beta}
                aria-label="Beta APIs"
                disabled={!!level.beta || busy}
                onClick={() => setBeta(!beta)}
              >
                <span />
              </button>
            </div>
            <div className="setting">
              <div className="grow">
                <b>Default gamemode</b>
                <div className="muted small">Written to level.dat</div>
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
    </section>
  );
}
