/** A tiny known_hosts store: `host[:port] key-type base64-key` per line. */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

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
}
