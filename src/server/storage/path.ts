/**
 * POSIX-style paths for every storage. Relative paths resolve against the storage root;
 * absolute ones ("/srv/x", or "C:/x" for local folders on Windows) are used as-is.
 */
import { posix } from "node:path";

const isDriveRoot = (path: string) => path.length === 2 && path[1] === ":" && /[A-Za-z]/.test(path[0]!);
const fixDrive = (path: string) => (isDriveRoot(path) ? `${path}/` : path);
const isDriveAbsolute = (part: string) => part.length > 1 && part[1] === ":" && /[A-Za-z]/.test(part[0]!);

export function join(...parts: (string | null | undefined)[]): string {
  let cleaned = parts.filter((part): part is string => !!part && part !== ".").map((part) => part.replaceAll("\\", "/"));
  if (!cleaned.length) return "";
  for (let index = cleaned.length - 1; index > 0; index--) {
    // An absolute part (POSIX or Windows drive) replaces everything before it.
    if (cleaned[index]!.startsWith("/") || isDriveAbsolute(cleaned[index]!)) {
      cleaned = cleaned.slice(index);
      break;
    }
  }
  let joined = posix.normalize(posix.join(...cleaned));
  if (joined === ".") return "";
  if (joined.length > 1 && joined.endsWith("/")) joined = joined.slice(0, -1);
  return fixDrive(joined);
}

export function parent(path: string): string {
  const head = posix.dirname(path.replaceAll("\\", "/").replace(/\/+$/, ""));
  return fixDrive(head === "." ? "" : head);
}

export function basename(path: string): string {
  return posix.basename(path.replaceAll("\\", "/").replace(/\/+$/, ""));
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || isDriveAbsolute(path.replaceAll("\\", "/"));
}

/** `child` relative to `root`, or null when it is not inside it. */
export function relative(root: string, child: string): string | null {
  const a = join(root);
  const b = join(child);
  if (!a) return b;
  if (b === a) return "";
  return b.startsWith(`${a}/`) ? b.slice(a.length + 1) : null;
}

/** Names that archives and file managers leave behind and nobody wants uploaded. */
export const JUNK_NAMES = new Set(["__MACOSX", ".DS_Store", "Thumbs.db", "desktop.ini"]);
