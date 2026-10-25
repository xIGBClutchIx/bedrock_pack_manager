/** Domain types shared by the server and the web UI. */

export type Protocol = "local" | "sftp" | "ftp" | "ftps" | "ftps-implicit";
export const PROTOCOLS: readonly Protocol[] = ["sftp", "ftp", "ftps", "ftps-implicit", "local"];
export const DEFAULT_PORTS: Record<Protocol, number | null> = { sftp: 22, ftp: 21, ftps: 21, "ftps-implicit": 990, local: null };

export interface ConnectionSettings {
  protocol: Protocol;
  host: string;
  port: number | null;
  username: string;
  /** Folder to start in. Empty = the login folder (remote) or the bundled run/ folder (local). */
  root: string;
  password?: string;
  keyFile?: string;
  keyPassphrase?: string;
  /** FTPS: verify the server certificate. (FTP always uses passive mode.) */
  tlsVerify: boolean;
  /** SFTP: a host key fingerprint the user confirmed (SHA256:...). */
  trustedFingerprint?: string;
}

/** Settings that are safe to save or show: never passwords or passphrases. */
export type PublicConnectionSettings = Omit<ConnectionSettings, "password" | "keyPassphrase" | "trustedFingerprint">;

export type PackKind = "bp" | "rp";
export type PackScope = "shared" | "world" | "dev";
export type InstallScope = "shared" | "world";
export type DuplicateMode = "replace" | "skip" | "keep-both";
export type Gamemode = "survival" | "creative" | "adventure";
export const GAMEMODES: readonly Gamemode[] = ["survival", "creative", "adventure"];

/** Manifest versions are usually [1, 0, 0]; some newer ones use "1.0.0". */
export type Version = (number | string)[];

export interface LayoutOverrides {
  serverRoot?: string;
  worldsDir?: string;
  bpDir?: string;
  rpDir?: string;
  packScope: InstallScope;
}

/** The detected layout, with every folder shown as a full server path. */
export interface LayoutInfo {
  serverRoot: string;
  worldsDir: string | null;
  singleWorld: string | null;
  bpDir: string | null;
  rpDir: string | null;
  devBpDir: string | null;
  devRpDir: string | null;
  levelName: string | null;
  packScope: InstallScope;
  notes: string[];
  /** server.properties, when the server has one. */
  serverProperties: string | null;
  /** server.properties texturepack-required: clients must download the resource packs. Null when unset. */
  texturepackRequired: boolean | null;
}

export interface WorldSummary {
  /** Storage path, used as the world id in API calls. */
  path: string;
  name: string;
  hasLevelDat: boolean;
  bpCount: number | null;
  rpCount: number | null;
  /** True for the world named by server.properties level-name. */
  isLevelName: boolean;
}

export interface Dependency {
  uuid?: string;
  version?: Version | string;
  module_name?: string;
}

export type PackStatus = "ok" | "missing" | "version-mismatch" | "unregistered";

/**
 * How a dependency stands in this world: registered ("active"), on the server but not registered
 * ("inactive"), nowhere ("missing"), or a game script module that needs no pack ("module").
 */
export type DependencyState = "active" | "inactive" | "missing" | "module";

export interface DependencyInfo {
  uuid: string | null;
  moduleName: string | null;
  /** The version the manifest asks for. */
  versionLabel: string;
  name: string;
  state: DependencyState;
  kind: PackKind | null;
  /** For an inactive dependency: the newest copy on the server, to register. */
  serverVersion: Version | null;
  /** The registered or available version is older than required. */
  tooOld: boolean;
}

export interface SubpackInfo {
  folder: string;
  name: string;
}

export interface PackRow {
  /** Stable selection key: `${kind}:${uuid}:${version}`. Empty for unregistered packs. */
  key: string;
  kind: PackKind;
  uuid: string;
  version: Version;
  versionLabel: string;
  name: string;
  status: PackStatus;
  registered: boolean;
  /** Display paths of matching folders on the server. */
  paths: string[];
  /** Storage path of the folder the row is about (for icons and folder actions), when there is one. */
  path: string | null;
  onServerVersions: string[];
  scope: PackScope | null;
  dependencies: DependencyInfo[];
  /** Position in the world's pack list (0 = first, the highest priority). Null when not registered. */
  order: number | null;
  /** A newer copy on the server than the registered version, if any. */
  newerOnServer: Version | null;
  /** Other worlds that register this pack, with the version each uses. */
  usedBy: { world: string; versionLabel: string }[];
  description: string;
  authors: string[];
  minEngineVersion: string | null;
  subpacks: SubpackInfo[];
  /** Resource packs: the subpack this world picked. */
  subpack: string | null;
}

export type ProblemKind = "nested" | "partial" | "misplaced" | "duplicate" | "broken" | "dependency" | "registration" | "casing";

export interface Problem {
  kind: ProblemKind;
  message: string;
  /** Storage path the problem is about, when there is one. */
  path?: string;
  /** Set when the app can fix it (currently: moving a nested pack up a folder). */
  fixable?: boolean;
}

export interface Experiment {
  /** level.dat key under `experiments`, e.g. "gametest". */
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface LevelInfo {
  exists: boolean;
  /** Beta APIs (the "gametest" experiment). */
  beta: boolean | null;
  gamemode: Gamemode | null;
  levelName: string | null;
  error: string | null;
  /** Known experiments plus any others this level.dat has. */
  experiments: Experiment[];
}

export interface WorldStatus {
  world: string;
  worldName: string;
  /** This is the world server.properties loads (level-name). */
  isLevelName: boolean;
  packs: PackRow[];
  problems: Problem[];
  notes: string[];
  hiddenBuiltin: number;
  level: LevelInfo;
  installDirs: { bp: string; rp: string };
}

export type PlanAction = "upload" | "replace" | "register" | "skip";

export interface PlanItem {
  name: string;
  uuid: string;
  version: Version;
  versionLabel: string;
  kind: PackKind;
  source: string;
  action: PlanAction;
  reason: string;
  target: string;
  replaces: string[];
  keeps: string[];
  /** Something to double-check before installing (a downgrade, a UUID shared with a different pack...). */
  warnings: string[];
}

export interface InstallStats {
  installed: number;
  skipped: number;
  errors: number;
}

export interface InstallResult {
  plan: PlanItem[];
  stats: InstallStats;
  applied: boolean;
  dryRun: boolean;
  /** Fresh world status after applying, built from the in-memory index (no second scan). */
  status?: WorldStatus;
  worlds?: WorldSummary[];
}

export interface UninstallResult {
  removed: number;
  deleted: string[];
  status: WorldStatus;
  worlds: WorldSummary[];
}

export interface CleanupResult {
  deleted: string[];
  kept: string[];
  dryRun: boolean;
  status?: WorldStatus;
}

export interface RebuildResult {
  behaviorPacks: number;
  resourcePacks: number;
  status: WorldStatus;
  worlds: WorldSummary[];
}

export interface FixNestingResult {
  moves: { from: string; to: string }[];
  dryRun: boolean;
  status?: WorldStatus;
}

export interface WorldEditResult {
  /** Human-readable list of what changed; empty when level.dat already matched. */
  changed: string[];
  status: WorldStatus;
}

/** One change to a world's pack lists. */
export type WorldPackChange =
  /** Register a pack (or switch it to `version`) in this world, or in each of `worlds`. */
  | { type: "register"; kind: PackKind; uuid: string; version: Version; worlds?: string[] }
  /** Reorder registered packs: `uuids` first, in this order; the rest keep their order after them. */
  | { type: "order"; kind: PackKind; uuids: string[] }
  /** Pick a resource pack's subpack, or clear it. */
  | { type: "subpack"; uuid: string; subpack: string | null };

export interface WorldPacksResult {
  applied: string[];
  status: WorldStatus;
  worlds: WorldSummary[];
}

export interface KnownHost {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

export interface BrowseResult {
  path: string;
  display: string;
  parent: string | null;
  dirs: string[];
}

export interface ConnectResult {
  label: string;
  layout: LayoutInfo;
  worlds: WorldSummary[];
  defaultWorld: string | null;
}

export interface UploadEntry {
  name: string;
  isDir: boolean;
  files: number;
  size: number;
}

export interface Profile {
  name: string;
  settings: PublicConnectionSettings;
  layout: LayoutOverrides;
}

/**
 * The local demo server from `npm run demo`: fixed ports, a test login, and a fixed (not secret)
 * host key in tests/servers/demo-host-key. The connect page offers it when the app runs with --test-server.
 */
export const TEST_SERVER = {
  host: "127.0.0.1",
  sftpPort: 2022,
  ftpPort: 2021,
  username: "mc",
  password: "pw",
  fingerprint: "SHA256:+DOpMX7PMxdsPSbcsOH6TuxNFmBfCA/5hEbO705DSPA",
} as const;

export function formatVersion(version: Version | string | undefined): string {
  if (Array.isArray(version)) return version.join(".");
  return String(version ?? "?");
}

export function packKey(kind: PackKind, uuid: string, version: Version): string {
  return `${kind}:${uuid}:${formatVersion(version)}`;
}

export function publicSettings(settings: ConnectionSettings): PublicConnectionSettings {
  const { password: _password, keyPassphrase: _passphrase, trustedFingerprint: _fingerprint, ...rest } = settings;
  return rest;
}

export function describeConnection(settings: PublicConnectionSettings): string {
  if (settings.protocol === "local") return settings.root || "run/";
  const scheme = settings.protocol === "ftps-implicit" ? "ftps" : settings.protocol;
  const user = settings.username ? `${settings.username}@` : "";
  const port = settings.port ?? DEFAULT_PORTS[settings.protocol];
  const root = settings.root ? (settings.root.startsWith("/") ? settings.root : `/${settings.root}`) : "/";
  return `${scheme}://${user}${settings.host}:${port}${root}`;
}
