/** The one live server connection, its layout, and what the UI was last told about it. */
import type { ConnectionSettings, LayoutOverrides, WorldSummary } from "../../shared/model";
import { ERROR_CODES } from "../../shared/events";
import { NothingToDoError } from "../core/commands/worldEdit";
import { SelectionError } from "../core/commands/uninstall";
import { worldSummaries } from "../core/commands/status";
import { Target } from "../core/layout";
import { WorldJsonError } from "../core/worlds";
import { JobFailure } from "../jobs/runner";
import { openStorage } from "../storage/connect";
import { HostKeyMismatchError, StorageError, UnknownHostKeyError } from "../storage/errors";
import type { AppPaths } from "../app/paths";

export const DEFAULT_OVERRIDES: LayoutOverrides = { packScope: "shared" };

export class Session {
  target: Target | null = null;
  settings: ConnectionSettings | null = null;
  overrides: LayoutOverrides = { ...DEFAULT_OVERRIDES };
  worlds: WorldSummary[] = [];
  defaultWorld: string | null = null;

  constructor(private readonly paths: AppPaths) {}

  requireTarget(): Target {
    if (!this.target) throw new JobFailure("Not connected to a server", ERROR_CODES.notConnected);
    return this.target;
  }

  async requireWorld(world: unknown): Promise<string> {
    const target = this.requireTarget();
    const path = typeof world === "string" ? world : "";
    if (!this.worlds.some((summary) => summary.path === path) && !(await target.storage.isDir(path))) {
      throw new JobFailure(`World '${path}' was not found`, ERROR_CODES.worldMissing);
    }
    return path;
  }

  async connect(settings: ConnectionSettings, overrides: LayoutOverrides): Promise<Target> {
    await this.disconnect();
    // The bundled run/ folder is the default local server, as in the original tool.
    const local = settings.protocol === "local" && !settings.root;
    const storage = await openStorage(local ? { ...settings, root: this.paths.runDir } : settings, {
      baseDir: process.cwd(),
      knownHostsFile: this.paths.knownHostsFile,
    });
    try {
      this.target = await Target.open(storage, overrides);
    } catch (error) {
      await storage.close();
      throw error;
    }
    this.settings = settings;
    this.overrides = { ...overrides };
    await this.refreshWorlds();
    return this.target;
  }

  async relayout(overrides: LayoutOverrides): Promise<Target> {
    const storage = this.requireTarget().storage;
    storage.clearCache();
    this.target = await Target.open(storage, overrides);
    this.overrides = { ...overrides };
    await this.refreshWorlds();
    return this.target;
  }

  async refreshWorlds(worlds?: WorldSummary[]): Promise<void> {
    const target = this.requireTarget();
    this.worlds = worlds ?? (await worldSummaries(target));
    this.defaultWorld = await target.defaultWorld(this.worlds.map((world) => world.path));
  }

  async disconnect(): Promise<void> {
    await this.target?.storage.close();
    this.target = null;
    this.settings = null;
    this.worlds = [];
    this.defaultWorld = null;
  }
}

/** Translate known errors into codes the UI understands. */
export function mapJobError(error: unknown): JobFailure | null {
  if (error instanceof UnknownHostKeyError) {
    return new JobFailure(error.message, ERROR_CODES.unknownHostKey, {
      host: error.host,
      port: error.port,
      keyType: error.keyType,
      fingerprint: error.fingerprint,
    });
  }
  if (error instanceof HostKeyMismatchError) return new JobFailure(error.message, ERROR_CODES.hostKeyMismatch);
  if (error instanceof SelectionError || error instanceof NothingToDoError)
    return new JobFailure(error.message, ERROR_CODES.nothingSelected);
  if (error instanceof WorldJsonError) return new JobFailure(error.message, "world_json");
  if (error instanceof StorageError) return new JobFailure(error.message, ERROR_CODES.connectFailed);
  return null;
}
