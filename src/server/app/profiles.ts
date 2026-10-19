/** Saved servers. Only public settings are stored: never passwords or passphrases. */
import { readFileSync, writeFileSync } from "node:fs";

import type { LayoutOverrides, Profile, PublicConnectionSettings } from "../../shared/model";
import { publicSettings } from "../../shared/model";

export class ProfileStore {
  constructor(private readonly file: string) {}

  list(): Profile[] {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(data)
        ? data.filter((profile): profile is Profile => !!profile && typeof profile.name === "string" && !!profile.settings)
        : [];
    } catch {
      return [];
    }
  }

  save(name: string, settings: PublicConnectionSettings, layout: LayoutOverrides): Profile[] {
    const clean: Profile = { name: name.trim(), settings: publicSettings(settings as never), layout: { ...layout } };
    const profiles = this.list().filter((profile) => profile.name !== clean.name);
    profiles.push(clean);
    profiles.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    this.write(profiles);
    return profiles;
  }

  delete(name: string): Profile[] {
    const profiles = this.list().filter((profile) => profile.name !== name);
    this.write(profiles);
    return profiles;
  }

  private write(profiles: Profile[]): void {
    writeFileSync(this.file, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
  }
}
