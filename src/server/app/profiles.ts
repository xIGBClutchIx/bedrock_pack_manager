/** Saved servers. Only public settings are stored: never passwords or passphrases. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { LayoutOverrides, Profile, Protocol, PublicConnectionSettings } from "../../shared/model";
import { PROTOCOLS } from "../../shared/model";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Only the fields a profile has, with the right types: a request can't smuggle extra keys (or a password) in. */
export function cleanProfileSettings(raw: unknown): PublicConnectionSettings | null {
  const data = (raw ?? {}) as Record<string, unknown>;
  if (!PROTOCOLS.includes(data.protocol as Protocol)) return null;
  const port = Number(data.port);
  return {
    protocol: data.protocol as Protocol,
    host: text(data.host).trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    username: text(data.username).trim(),
    root: text(data.root).trim(),
    ...(text(data.keyFile).trim() ? { keyFile: text(data.keyFile).trim() } : {}),
    tlsVerify: data.tlsVerify !== false,
  };
}

export class ProfileStore {
  constructor(private readonly file: string) {}

  list(): Profile[] {
    if (!existsSync(this.file)) return [];
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // Keep a damaged file for the user instead of overwriting it with the next save.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // nothing else to do; the list is empty either way
      }
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data.flatMap((profile: Record<string, unknown>) => {
      const settings = cleanProfileSettings(profile?.settings);
      if (typeof profile?.name !== "string" || !settings) return [];
      return [{ name: profile.name, settings, layout: { ...(profile.layout as LayoutOverrides) } }];
    });
  }

  save(name: string, settings: PublicConnectionSettings, layout: LayoutOverrides): Profile[] {
    const clean = cleanProfileSettings(settings);
    if (!clean) throw new Error("Unknown protocol");
    const profiles = this.list().filter((profile) => profile.name !== name.trim());
    profiles.push({ name: name.trim(), settings: clean, layout: { ...layout } });
    profiles.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    this.write(profiles);
    return profiles;
  }

  delete(name: string): Profile[] {
    const profiles = this.list().filter((profile) => profile.name !== name);
    this.write(profiles);
    return profiles;
  }

  /** Write a temp file and rename it over the old one, so a crash mid-write never leaves half a file. */
  private write(profiles: Profile[]): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
    renameSync(temp, this.file);
  }
}
