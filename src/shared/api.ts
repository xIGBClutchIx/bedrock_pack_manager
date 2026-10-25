/** HTTP API contract. Every /api route needs the `X-BPM-Token` header (or `?t=` for downloads and SSE). */

import type { JobInfo } from "./events";
import type {
  ConnectionSettings,
  DuplicateMode,
  Gamemode,
  LayoutInfo,
  LayoutOverrides,
  Profile,
  PublicConnectionSettings,
  UploadEntry,
  WorldPackChange,
  WorldSummary,
} from "./model";

export const TOKEN_HEADER = "x-bpm-token";

export interface AppStateResponse {
  connected: boolean;
  label: string | null;
  settings: PublicConnectionSettings | null;
  layout: LayoutInfo | null;
  overrides: LayoutOverrides;
  worlds: WorldSummary[];
  defaultWorld: string | null;
  activeJob: JobInfo | null;
  uploads: UploadEntry[];
  profiles: Profile[];
  /** Started with --test-server: offer one-click connects to the local demo server (TEST_SERVER). */
  testServer: boolean;
}

/** Every mutating or slow route answers with the job it started; follow it at /api/jobs/:id/events. */
export interface JobStarted {
  job: string;
}

export interface ApiError {
  error: string;
  code: string;
}

export interface ConnectRequest {
  settings: ConnectionSettings;
  layout: LayoutOverrides;
}

export interface LayoutRequest {
  layout: LayoutOverrides;
}

export interface WorldRequest {
  world: string;
}

export interface StatusRequest extends WorldRequest {
  refreshWorlds?: boolean;
}

export interface InstallRequest extends WorldRequest {
  duplicateMode: DuplicateMode;
  reupload: boolean;
  dryRun: boolean;
}

export interface UninstallRequest extends WorldRequest {
  keys: string[];
  keepFiles: boolean;
}

export interface CleanupRequest extends WorldRequest {
  dryRun: boolean;
  /** Only these pack folders (storage paths); all unused ones when omitted. */
  paths?: string[];
}

export interface WorldPacksRequest extends WorldRequest {
  changes: WorldPackChange[];
}

export interface ServerPropertiesRequest {
  texturepackRequired: boolean;
}

export interface FixNestingRequest extends WorldRequest {
  paths: string[];
  dryRun: boolean;
}

export interface WorldEditRequest extends WorldRequest {
  /** Experiments to switch on or off, by level.dat key ("gametest" is Beta APIs). */
  experiments?: Record<string, boolean>;
  gamemode?: Gamemode | null;
}

export interface SaveProfileRequest {
  name: string;
  settings: PublicConnectionSettings;
  layout: LayoutOverrides;
}

export const ROUTES = {
  state: "/api/state",
  connect: "/api/connect",
  disconnect: "/api/disconnect",
  layout: "/api/layout",
  status: "/api/status",
  install: "/api/install",
  uninstall: "/api/uninstall",
  rebuild: "/api/rebuild",
  cleanup: "/api/cleanup",
  audit: "/api/audit",
  worldEdit: "/api/world-edit",
  fixNesting: "/api/fix-nesting",
  backup: "/api/backup",
  uploads: "/api/uploads",
  profiles: "/api/profiles",
  worldPacks: "/api/world-packs",
  serverProperties: "/api/server-properties",
  knownHosts: "/api/known-hosts",
  browse: "/api/browse",
  packIcon: "/api/pack-icon",
  appLog: "/api/logs/latest",
  jobs: "/api/jobs",
  job: (id: string) => `/api/jobs/${encodeURIComponent(id)}`,
  jobEvents: (id: string) => `/api/jobs/${encodeURIComponent(id)}/events`,
  jobCancel: (id: string) => `/api/jobs/${encodeURIComponent(id)}/cancel`,
  jobLog: (id: string) => `/api/jobs/${encodeURIComponent(id)}/log`,
} as const;
