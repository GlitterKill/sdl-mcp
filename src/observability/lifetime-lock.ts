import { randomBytes as nodeRandomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  resolveLifetimeFileSystem,
  rotateLifetimeEvidence,
  type LifetimeFileSystem,
  type LifetimeFileSystemOverrides,
} from "./lifetime-evidence.js";

export const LIFETIME_LOCK_FILENAME = "sdl-observability-lifetime.lock.json";
const LOCK_SCHEMA_VERSION = 1;
const MAX_LOCK_BYTES = 8 * 1024;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE = /^[0-9a-f]{32}$/;

interface LifetimeLockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly createdAt: string;
  readonly nonce: string;
}

interface StableLockRecord {
  readonly record: LifetimeLockRecord;
  readonly identity: string;
}

export interface LifetimeWriterLease extends LifetimeLockRecord {
  readonly directory: string;
  readonly lockPath: string;
}

export type LifetimeLeaseResult =
  | { readonly mode: "writer"; readonly lease: LifetimeWriterLease }
  | {
      readonly mode: "readOnly";
      readonly reason: "contended" | "invalidLock" | "ioFailure";
    };

export interface LifetimeLockOptions {
  readonly now?: () => Date;
  readonly pid?: number;
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly randomBytes?: (size: number) => Buffer;
  readonly fileSystem?: LifetimeFileSystemOverrides;
}

type CreateResult =
  | { readonly status: "writer"; readonly lease: LifetimeWriterLease }
  | { readonly status: "exists" }
  | { readonly status: "failure" };

function identity(stat: Stats): string {
  return `${stat.dev.toString()}:${stat.ino.toString()}`;
}

function isRegularLock(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_LOCK_BYTES;
}

function strictIso(date: Date): string {
  const value = date.toISOString();
  if (!ISO_TIMESTAMP.test(value)) throw new Error("Invalid lifetime lock timestamp");
  return value;
}

function parseLockRecord(raw: string): LifetimeLockRecord | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_LOCK_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(value)) !==
        JSON.stringify(["schemaVersion", "pid", "createdAt", "nonce"]) ||
      value.schemaVersion !== LOCK_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.createdAt !== "string" ||
      !ISO_TIMESTAMP.test(value.createdAt) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      typeof value.nonce !== "string" ||
      !NONCE.test(value.nonce)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      pid: Number(value.pid),
      createdAt: value.createdAt,
      nonce: value.nonce,
    };
  } catch {
    return null;
  }
}

function serializeLock(record: LifetimeLockRecord): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    pid: record.pid,
    createdAt: record.createdAt,
    nonce: record.nonce,
  });
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

async function readStableLock(
  lockPath: string,
  fileSystem: LifetimeFileSystem,
): Promise<StableLockRecord | null> {
  const before = await fileSystem.lstat(lockPath);
  if (!isRegularLock(before)) return null;
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(
      lockPath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!isRegularLock(opened) || identity(opened) !== identity(before)) return null;
    const raw = await handle.readFile({ encoding: "utf8" });
    const afterOpen = await handle.stat();
    const afterPath = await fileSystem.lstat(lockPath);
    if (
      !isRegularLock(afterOpen) ||
      !isRegularLock(afterPath) ||
      identity(afterOpen) !== identity(opened) ||
      identity(afterPath) !== identity(opened) ||
      afterOpen.size !== opened.size ||
      afterPath.size !== opened.size
    ) {
      return null;
    }
    const record = parseLockRecord(raw);
    return record ? { record, identity: identity(opened) } : null;
  } catch {
    return null;
  } finally {
    await closeQuietly(handle);
  }
}

function leaseFor(
  directory: string,
  lockPath: string,
  record: LifetimeLockRecord,
): LifetimeWriterLease {
  return { ...record, directory, lockPath };
}

async function removeIfOwned(
  lease: LifetimeWriterLease,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  const current = await readStableLock(lease.lockPath, fileSystem);
  if (
    !current ||
    current.record.schemaVersion !== lease.schemaVersion ||
    current.record.pid !== lease.pid ||
    current.record.nonce !== lease.nonce
  ) {
    return false;
  }
  const beforeDelete = await fileSystem.lstat(lease.lockPath);
  if (!isRegularLock(beforeDelete) || identity(beforeDelete) !== current.identity) return false;
  await fileSystem.unlink(lease.lockPath);
  return true;
}

async function createWriterLock(
  directory: string,
  lockPath: string,
  record: LifetimeLockRecord,
  fileSystem: LifetimeFileSystem,
): Promise<CreateResult> {
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(lockPath, "wx", 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST"
      ? { status: "exists" }
      : { status: "failure" };
  }

  const lease = leaseFor(directory, lockPath, record);
  try {
    if (process.platform === "win32") {
      await handle.chmod(0o600).catch(() => undefined);
    } else {
      await handle.chmod(0o600);
    }
    await handle.writeFile(serializeLock(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const stored = await readStableLock(lockPath, fileSystem);
    if (
      !stored ||
      stored.record.pid !== record.pid ||
      stored.record.createdAt !== record.createdAt ||
      stored.record.nonce !== record.nonce
    ) {
      await removeIfOwned(lease, fileSystem).catch(() => false);
      return { status: "failure" };
    }
    return { status: "writer", lease };
  } catch {
    await closeQuietly(handle);
    await removeIfOwned(lease, fileSystem).catch(() => false);
    return { status: "failure" };
  }
}

function defaultPidLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOnly(reason: "contended" | "invalidLock" | "ioFailure"): LifetimeLeaseResult {
  return { mode: "readOnly", reason };
}

/** Acquire once, or reclaim one proven-dead owner and retry exactly once. */
export async function acquireLifetimeLease(
  directory: string,
  options: LifetimeLockOptions = {},
): Promise<LifetimeLeaseResult> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  const trustedDirectory = resolve(directory);
  try {
    const directoryStat = await fileSystem.lstat(trustedDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return readOnly("invalidLock");
    }
  } catch {
    return readOnly("ioFailure");
  }

  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return readOnly("ioFailure");
  let createdAt: string;
  let nonce: string;
  try {
    createdAt = strictIso((options.now ?? (() => new Date()))());
    const nonceBytes = (options.randomBytes ?? nodeRandomBytes)(16);
    if (nonceBytes.length !== 16) return readOnly("ioFailure");
    nonce = nonceBytes.toString("hex");
  } catch {
    return readOnly("ioFailure");
  }
  const record: LifetimeLockRecord = { schemaVersion: 1, pid, createdAt, nonce };
  const lockPath = resolve(trustedDirectory, LIFETIME_LOCK_FILENAME);
  const initial = await createWriterLock(
    trustedDirectory,
    lockPath,
    record,
    fileSystem,
  );
  if (initial.status === "writer") return { mode: "writer", lease: initial.lease };
  if (initial.status === "failure") return readOnly("ioFailure");

  const existing = await readStableLock(lockPath, fileSystem);
  if (!existing) return readOnly("invalidLock");
  let alive: boolean;
  try {
    alive = await (options.isPidAlive ?? defaultPidLiveness)(existing.record.pid);
  } catch {
    return readOnly("ioFailure");
  }
  if (alive) return readOnly("contended");

  try {
    await rotateLifetimeEvidence(
      trustedDirectory,
      lockPath,
      { kind: "lock", eligibility: "validated-supported" },
      {
        now: options.now,
        randomBytes: options.randomBytes,
        fileSystem: options.fileSystem,
      },
    );
  } catch {
    return readOnly("ioFailure");
  }
  const retry = await createWriterLock(
    trustedDirectory,
    lockPath,
    record,
    fileSystem,
  );
  return retry.status === "writer"
    ? { mode: "writer", lease: retry.lease }
    : readOnly(retry.status === "exists" ? "contended" : "ioFailure");
}

async function writeAtStart(handle: FileHandle, content: string): Promise<void> {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesWritten === 0) throw new Error("Unable to refresh lifetime lock");
    offset += bytesWritten;
  }
  await handle.truncate(buffer.length);
}

/** Refresh ownership only through the descriptor that was revalidated. */
export async function refreshLifetimeLease(
  lease: LifetimeWriterLease,
  options: Pick<LifetimeLockOptions, "now" | "fileSystem"> = {},
): Promise<boolean> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  let handle: FileHandle | undefined;
  try {
    const before = await fileSystem.lstat(lease.lockPath);
    if (!isRegularLock(before)) return false;
    handle = await fileSystem.open(
      lease.lockPath,
      constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!isRegularLock(opened) || identity(opened) !== identity(before)) return false;
    const current = parseLockRecord(await handle.readFile({ encoding: "utf8" }));
    if (
      !current ||
      current.schemaVersion !== lease.schemaVersion ||
      current.pid !== lease.pid ||
      current.nonce !== lease.nonce
    ) {
      return false;
    }
    const beforeWrite = await fileSystem.lstat(lease.lockPath);
    if (!isRegularLock(beforeWrite) || identity(beforeWrite) !== identity(opened)) return false;
    const refreshed: LifetimeLockRecord = {
      schemaVersion: 1,
      pid: current.pid,
      createdAt: strictIso((options.now ?? (() => new Date()))()),
      nonce: current.nonce,
    };
    await writeAtStart(handle, serializeLock(refreshed));
    await handle.sync();
    const afterWrite = await fileSystem.lstat(lease.lockPath);
    return isRegularLock(afterWrite) && identity(afterWrite) === identity(opened);
  } catch {
    return false;
  } finally {
    await closeQuietly(handle);
  }
}

/** Remove only the lock record still owned by this exact lease. */
export async function releaseLifetimeLease(
  lease: LifetimeWriterLease,
  options: Pick<LifetimeLockOptions, "fileSystem"> = {},
): Promise<boolean> {
  try {
    return await removeIfOwned(
      lease,
      resolveLifetimeFileSystem(options.fileSystem),
    );
  } catch {
    return false;
  }
}
