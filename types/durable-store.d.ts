export const DEFAULT_LOCK_TIMEOUT_MS: number;
export const DEFAULT_LOCK_STALE_MS: number;
export const DEFAULT_DURABLE_BACKUPS: number;

export class CorruptedStateError extends Error {
  code: 'CPR_CORRUPTED_STATE';
  statusCode: 500;
  file: string;
  reason: 'permission' | 'io' | 'truncated' | 'parse' | 'invalid';
  cause?: Error;
}

export class RevisionConflictError extends Error {
  code: 'CPR_REVISION_CONFLICT';
  statusCode: 409;
  file: string;
  expectedRevision: number;
  actualRevision: number;
}

export class LockTimeoutError extends Error {
  code: 'CPR_LOCK_TIMEOUT';
  statusCode: 503;
  lockFile: string;
  timeoutMs: number;
  holder: { pid?: number; hostname?: string; owner?: string; acquiredAt?: number } | null;
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  owner?: string;
}

export interface FileLockHandle {
  file: string;
  token: string;
  release(): void;
}

export function acquireFileLock(lockFile: string, options?: FileLockOptions): FileLockHandle;
export function withFileLock<T>(lockFile: string, options: FileLockOptions, fn: () => T): T;
export function withFileLock<T>(lockFile: string, fn: () => T): T;

export interface DurableStoreOptions<P> {
  file: string;
  schemaName: string;
  schemaVersion?: number;
  payloadKey?: string;
  defaultPayload?: P;
  migrateLegacy?(raw: unknown): P | undefined;
  backups?: number;
  lockFile?: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  owner?: string;
}

export interface DurableLoadResult<P> {
  payload: P;
  revision: number;
  version: number;
  exists: boolean;
  recovered: boolean;
  source: string;
}

export interface DurableStore<P> {
  load(): DurableLoadResult<P>;
  save(payload: P, options?: { expectedRevision?: number }): { revision: number };
  mutate<R>(fn: (payload: P, ctx: { revision: number; exists: boolean }) => { next: P; result?: R } | null | undefined): { changed: boolean; revision: number; result: R | undefined };
  withLock<T>(fn: () => T): T;
  _file: string;
  _lockFile: string;
  _schemaName: string;
  _schemaVersion: number;
}

export function createDurableStore<P = unknown>(options: DurableStoreOptions<P>): DurableStore<P>;
