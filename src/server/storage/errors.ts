/** A file or folder that does not exist. Every backend maps its own "missing" errors to this. */
export class NotFoundError extends Error {
  readonly code = "ENOENT";
  constructor(readonly path: string) {
    super(`Not found: ${path}`);
    this.name = "NotFoundError";
  }
}

/** A transport or permission failure that is not simply a missing file. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class UnknownHostKeyError extends StorageError {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly keyType: string,
    readonly fingerprint: string,
  ) {
    super(`Unknown SSH host key for ${host}:${port} (${keyType} ${fingerprint}). Confirm the fingerprint to trust it.`);
    this.name = "UnknownHostKeyError";
  }
}

export class HostKeyMismatchError extends StorageError {
  constructor(host: string, fingerprint: string) {
    super(
      `The SSH host key for ${host} changed (now ${fingerprint}). The server may have been reinstalled, or someone may be intercepting the connection.`,
    );
    this.name = "HostKeyMismatchError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

export const isNotFound = (error: unknown): error is NotFoundError => error instanceof NotFoundError;

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
