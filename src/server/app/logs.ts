/** Plain-text run logs: run/logs/latest.txt plus the 5 most recent timestamped logs. */
import { appendFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LogLevel } from "../../shared/events";

const TAGS: Record<LogLevel, string> = {
  section: "==",
  ok: "[OK]",
  info: "[INFO]",
  warn: "[WARNING]",
  error: "[ERROR]",
  plain: "",
  detail: "  ",
};
const KEEP = 5;

export class RunLog {
  private readonly dated: string;
  private readonly latest: string;

  constructor(private readonly dir: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    this.dated = join(dir, `${stamp}.txt`);
    this.latest = join(dir, "latest.txt");
    writeFileSync(this.latest, "", "utf8");
    writeFileSync(this.dated, "", "utf8");
    this.prune();
  }

  write(level: LogLevel, text: string): void {
    const tag = TAGS[level];
    const line = `${level === "section" ? "\n" : ""}${tag ? `${tag} ` : ""}${text}\n`;
    try {
      appendFileSync(this.latest, line, "utf8");
      appendFileSync(this.dated, line, "utf8");
    } catch {
      // Logging must never break a job.
    }
  }

  private prune(): void {
    try {
      const logs = readdirSync(this.dir)
        .filter((name) => name.endsWith(".txt") && name !== "latest.txt")
        .map((name) => ({ name, time: statSync(join(this.dir, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      for (const old of logs.slice(KEEP)) unlinkSync(join(this.dir, old.name));
    } catch {
      // ignore
    }
  }
}
