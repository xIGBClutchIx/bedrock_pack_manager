/** A tiny known_hosts store: `host[:port] key-type base64-key` per line. */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { KnownHost } from "../../shared/model";

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** The key type is the first string inside an SSH public key blob. */
export function keyTypeOf(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString("ascii") || "unknown";
}

const hostEntry = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`);

export class KnownHosts {
  constructor(readonly file: string | null) {}

  /** "match", "mismatch" (a different key is stored for this host), or "unknown". */
  check(host: string, port: number, key: Buffer): "match" | "mismatch" | "unknown" {
    if (!this.file) return "unknown";
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return "unknown";
    }
    const entry = hostEntry(host, port);
    const encoded = key.toString("base64");
    let seen = false;
    for (const line of text.split(/\r?\n/)) {
      const [hostField, , keyField] = line.trim().split(/\s+/);
      if (!hostField || !keyField || !hostField.split(",").includes(entry)) continue;
      if (keyField === encoded) return "match";
      seen = true;
    }
    return seen ? "mismatch" : "unknown";
  }

  remember(host: string, port: number, key: Buffer): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${hostEntry(host, port)} ${keyTypeOf(key)} ${key.toString("base64")}\n`, "utf8");
  }

  private lines(): string[] {
    if (!this.file) return [];
    try {
      return readFileSync(this.file, "utf8").split(/\r?\n/);
    } catch {
      return [];
    }
  }

  /** Every trusted key, for people to review. */
  list(): KnownHost[] {
    return this.lines().flatMap((line) => {
      const [hostField, keyType, keyField] = line.trim().split(/\s+/);
      if (!hostField || !keyType || !keyField || hostField.startsWith("#")) return [];
      const key = Buffer.from(keyField, "base64");
      return hostField.split(",").map((entry) => ({ ...parseHostEntry(entry), keyType, fingerprint: fingerprintOf(key) }));
    });
  }

  /** Stop trusting a host's key(s), e.g. after the server was reinstalled. Returns how many were removed. */
  forget(host: string, port: number): number {
    if (!this.file) return 0;
    const entry = hostEntry(host, port);
    let removed = 0;
    const kept = this.lines().filter((line) => {
      const [hostField] = line.trim().split(/\s+/);
      const matches = !!hostField && hostField.split(",").includes(entry);
      if (matches) removed++;
      return !matches;
    });
    if (removed) writeFileSync(this.file, kept.join("\n"), "utf8");
    return removed;
  }
}

function parseHostEntry(entry: string): { host: string; port: number } {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(entry);
  return bracketed ? { host: bracketed[1]!, port: Number(bracketed[2]) } : { host: entry, port: 22 };
}
