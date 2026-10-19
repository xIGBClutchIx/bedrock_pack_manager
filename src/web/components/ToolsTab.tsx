/** Audit, rebuild, cleanup and backup. */
import { ROUTES } from "../../shared/api";
import type { CleanupResult, RebuildResult, WorldStatus } from "../../shared/model";
import { backupUrl } from "../api/client";
import { useApp } from "../state/app";
import { plural } from "./common";
import type { WorldContext } from "./Dashboard";

export function ToolsTab({ ctx }: { ctx: WorldContext }) {
  const { run, confirm, toast, refresh, busy, mark } = useApp();

  async function audit() {
    mark("Auditing");
    try {
      const job = await run<WorldStatus>(ROUTES.audit, { world: ctx.world }, { title: "Auditing" });
      ctx.setStatus(job.result);
      toast(job.warnings.length ? `Audit found ${plural(job.warnings.length, "issue")}` : "Audit clean", job.warnings.length > 0);
    } catch (error) {
      toast((error as Error).message, true);
    }
  }

  async function rebuild() {
    const ok = await confirm({
      title: "Rebuild world pack JSONs?",
      body: (
        <p>
          This overwrites <code>world_behavior_packs.json</code> and <code>world_resource_packs.json</code> for this world with every pack
          found on the server. Packs that are listed but missing are dropped. Built-in game packs are left out.
        </p>
      ),
      okLabel: "Rebuild",
      danger: true,
    });
    if (!ok) return;
    mark("Rebuilding world JSONs");
    try {
      const job = await run<RebuildResult>(ROUTES.rebuild, { world: ctx.world }, { title: "Rebuilding world JSONs" });
      ctx.setStatus(job.result.status);
      await refresh();
      toast("Rebuilt");
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
            <p>No world registers these. Built-in game packs and development folders are never touched.</p>
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
    <section className="panel tools">
      <div className="tool">
        <h3>Audit</h3>
        <p>Registrations, missing files, wrong versions, nesting mistakes and missing dependencies. Changes nothing.</p>
        <button className="btn" onClick={() => void audit()} disabled={busy}>
          Run audit
        </button>
      </div>
      <div className="tool">
        <h3>Rebuild world JSONs</h3>
        <p>Register every pack in the server folders, newest version of each. Game packs are skipped.</p>
        <button className="btn" onClick={() => void rebuild()} disabled={busy}>
          Rebuild…
        </button>
      </div>
      <div className="tool">
        <h3>Clean up folders</h3>
        <p>Delete pack folders no world uses. Shows the list before deleting anything.</p>
        <button className="btn" onClick={() => void cleanup()} disabled={busy}>
          Preview cleanup…
        </button>
      </div>
      <div className="tool">
        <h3>Backup</h3>
        <p>Download this world and the pack folders as a zip, streamed straight from the server.</p>
        <div className="row tight">
          <a className="btn" href={backupUrl(ctx.world)} aria-disabled={busy} onClick={(event) => busy && event.preventDefault()}>
            This world
          </a>
          <a className="btn ghost" href={backupUrl(null)} aria-disabled={busy} onClick={(event) => busy && event.preventDefault()}>
            Everything
          </a>
        </div>
      </div>
    </section>
  );
}
