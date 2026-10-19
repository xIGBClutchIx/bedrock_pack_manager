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
  /** FTPS: verify the server certificate. */
  tlsVerify: boolean;
  /** FTP: passive mode (almost always right). */
  passive: boolean;
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
  onServerVersions: string[];
  scope: PackScope | null;
  dependencies: Dependency[];
}

export type ProblemKind = "nested" | "partial" | "misplaced" | "duplicate" | "broken" | "dependency" | "registration";

export interface Problem {
  kind: ProblemKind;
  message: string;
  /** Storage path the problem is about, when there is one. */
  path?: string;
  /** Set when the app can fix it (currently: moving a nested pack up a folder). */
  fixable?: boolean;
}

export interface LevelInfo {
  exists: boolean;
  beta: boolean | null;
  gamemode: Gamemode | null;
  levelName: string | null;
  error: string | null;
}

export interface WorldStatus {
  world: string;
  worldName: string;
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
  betaChanged: boolean;
  gamemodeChanged: boolean;
  status: WorldStatus;
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
