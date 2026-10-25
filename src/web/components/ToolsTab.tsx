/** Audit, rebuild, cleanup and backup. */
import { ROUTES } from "../../shared/api";
import type { CleanupResult, RebuildResult, WorldStatus } from "../../shared/model";
import { backupUrl } from "../api/client";
import { useApp } from "../state/app";
import { plural } from "./common";
import { useBackupLink, type WorldContext } from "./Dashboard";

export function ToolsTab({ ctx }: { ctx: WorldContext }) {
  const { run, confirm, toast, refresh, busy, mark } = useApp();
  const onBackup = useBackupLink();

  async function audit() {
    mark("Checking the world");
    try {
      const job = await run<WorldStatus>(ROUTES.audit, { world: ctx.world }, { title: "Checking the world" });
      ctx.setStatus(job.result);
      toast(job.warnings.length ? `Found ${plural(job.warnings.length, "problem")}` : "No problems found", job.warnings.length > 0);
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  async function rebuild() {
    const ok = await confirm({
      title: "Register every pack on the server?",
      body: (
        <p>
          This registers every pack found on the server in <code>world_behavior_packs.json</code> and <code>world_resource_packs.json</code>{" "}
          for this world, newest version of each. Packs already listed keep their order and subpack; listed packs that are missing are
          dropped. Built-in game packs, skin packs and misplaced packs are left out.
        </p>
      ),
      okLabel: "Register all",
      danger: true,
    });
    if (!ok) return;
    mark("Registering every pack");
    try {
      const job = await run<RebuildResult>(ROUTES.rebuild, { world: ctx.world }, { title: "Registering every pack" });
      ctx.setStatus(job.result.status);
      await refresh();
      toast("Registered every pack");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  async function cleanup() {
    try {
      const preview = await run<CleanupResult>(ROUTES.cleanup, { world: ctx.world, dryRun: true }, { title: "Previewing cleanup" });
      if (!preview.result.deleted.length) return toast("Nothing to clean up");
      const ok = await confirm({
        title: `Delete ${plural(preview.result.deleted.length, "unused pack folder")}?`,
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
              <p>{plural(preview.result.kept.length, "unregistered folder")} will be kept because another world uses it.</p>
            )}
            <p>No world needs these. Built-in game packs and development folders are never touched.</p>
          </>
        ),
        okLabel: "Delete folders",
        danger: true,
      });
      if (!ok) return;
      const job = await run<CleanupResult>(ROUTES.cleanup, { world: ctx.world, dryRun: false }, { title: "Cleaning up" });
      if (job.result.status) ctx.setStatus(job.result.status);
      toast("Cleanup done");
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  return (
    <section className="panel narrow">
      <ul className="tool-list">
        <li>
          <div className="grow">
            <h3>Check this world</h3>
            <p>Lists missing files, wrong versions, nesting mistakes and missing dependencies. Changes nothing.</p>
          </div>
          <button className="btn" onClick={() => void audit()} disabled={busy}>
            Run check
          </button>
        </li>
        <li>
          <div className="grow">
            <h3>Register every pack</h3>
            <p>Adds the newest version of every pack on the server to this world, keeping the current order.</p>
          </div>
          <button className="btn" onClick={() => void rebuild()} disabled={busy}>
            Register all…
          </button>
        </li>
        <li>
          <div className="grow">
            <h3>Clean up folders</h3>
            <p>Deletes pack folders no world uses. You see the list first.</p>
          </div>
          <button className="btn" onClick={() => void cleanup()} disabled={busy}>
            Preview cleanup…
          </button>
        </li>
        <li>
          <div className="grow">
            <h3>Back up</h3>
            <p>Downloads a zip of the world and the pack folders. Stop the server first for a complete copy.</p>
          </div>
          <div className="row tight">
            <a className="btn" href={backupUrl(ctx.world)} aria-disabled={busy} onClick={onBackup}>
              This world
            </a>
            <a className="btn" href={backupUrl(null)} aria-disabled={busy} onClick={onBackup}>
              Whole server
            </a>
          </div>
        </li>
      </ul>
    </section>
  );
}
