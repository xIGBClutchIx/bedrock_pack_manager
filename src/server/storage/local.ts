/** Local folders: the bundled run/ layout, or a Bedrock server on this computer. */
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute as isAbsoluteLocal, relative as relativeLocal, resolve } from "node:path";

import { NotFoundError, StorageError } from "./errors";
import { join } from "./path";
import { Storage, type Entry } from "./storage";

function mapError(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") throw new NotFoundError(path);
  throw error instanceof Error ? error : new StorageError(String(error));
}

export class LocalStorage extends Storage {
  readonly label: string;
  // Local reads are cheap and other programs may change files: never cache listings.
  protected override readonly cacheListings = false;

  constructor(readonly root: string) {
    super(32);
    this.label = root;
  }

  resolve(path: string): string {
    const key = join(path);
    if (!key) return this.root;
    return isAbsoluteLocal(key) || key.startsWith("/") ? resolve(key) : resolve(this.root, key);
  }

  override describe(path: string): string {
    const full = this.resolve(path);
    const rel = relativeLocal(process.cwd(), full);
    return rel && !rel.startsWith("..") && !isAbsoluteLocal(rel) ? rel : full;
  }

  protected async rawList(path: string): Promise<Entry[]> {
    const full = this.resolve(path);
    try {
      const children = await readdir(full, { withFileTypes: true });
      return Promise.all(
        children.map(async (child) => {
          let isDir = child.isDirectory();
          let size: number | null = null;
          if (child.isSymbolicLink())
            isDir = await stat(`${full}/${child.name}`).then(
              (info) => info.isDirectory(),
              () => false,
            );
          if (!isDir)
            size = await stat(`${full}/${child.name}`).then(
              (info) => info.size,
              () => null,
            );
          return { name: child.name, isDir, size };
        }),
      );
    } catch (error) {
      mapError(error, full);
    }
  }

  protected async rawRead(path: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(path));
    } catch (error) {
      mapError(error, path);
    }
  }

  protected async rawWrite(path: string, data: Buffer): Promise<void> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  protected async rawMkdir(path: string): Promise<void> {
    await mkdir(this.resolve(path), { recursive: true });
  }

  protected async rawRemoveFile(path: string): Promise<void> {
    try {
      await unlink(this.resolve(path));
    } catch (error) {
      mapError(error, path);
    }
  }

  protected async rawRemoveDir(path: string): Promise<void> {
    await rmdir(this.resolve(path));
  }

  protected async rawRename(from: string, to: string): Promise<void> {
    await rename(this.resolve(from), this.resolve(to));
  }

  override async removeTree(path: string): Promise<void> {
    const full = this.resolve(path);
    if (full === this.root || !join(path)) throw new StorageError("Refusing to delete the storage root");
    await rm(full, { recursive: true, force: true });
  }

  override async copyFile(from: string, to: string): Promise<void> {
    const target = this.resolve(to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(this.resolve(from), target);
  }

  async close(): Promise<void> {}
}
