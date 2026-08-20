import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  claimLifetimeSource,
  isLifetimeDirectChild,
  lifetimeClaimErrorCode,
  moveClaimedLifetimeSource,
  readLifetimeSource,
  removeExactLifetimeSource,
  releaseLifetimeSourceClaim,
  resolveLifetimeFileSystem,
  rotateLifetimeEvidence,
  sameLifetimeIdentity,
  sameLifetimeSource,
  settleLifetimeClaim,
  validateLifetimeDirectory,
  type LifetimeClaimOptions,
  type LifetimeFileSystem,
  type LifetimeFileSystemOverrides,
  type LifetimeSourceClaim,
  type LifetimeSourceSnapshot,
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
  readonly snapshot: LifetimeSourceSnapshot;
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
  readonly isClaimantPidAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly signalPid?: (pid: number, signal: 0) => void;
  readonly randomBytes?: (size: number) => Buffer;
  readonly fileSystem?: LifetimeFileSystemOverrides;
}

type CreateResult =
  | { readonly status: "writer"; readonly lease: LifetimeWriterLease }
  | { readonly status: "exists" | "contended" | "failure" };

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

function serializeCreateAnchor(record: LifetimeLockRecord): string {
  const lock = {
    schemaVersion: record.schemaVersion,
    pid: record.pid,
    createdAt: record.createdAt,
    nonce: record.nonce,
  };
  return JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    createdAt: record.createdAt,
    nonce: record.nonce,
    lock,
    lockSha256: createHash("sha256").update(JSON.stringify(lock)).digest("hex"),
  });
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

function identitySnapshot(stat: BigIntStats): LifetimeSourceSnapshot {
  if (stat.size > BigInt(MAX_LOCK_BYTES)) throw new Error("Lifetime file exceeds its size limit");
  return {
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
    size: Number(stat.size),
    sha256: createHash("sha256").update("").digest("hex"),
  };
}

async function cleanupExactCreatedPath(
  path: string,
  expected: LifetimeSourceSnapshot | undefined,
  candidate: string,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  if (!expected) return;
  try {
    await fileSystem.lstat(candidate, { bigint: true });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  await removeExactLifetimeSource(path, expected, candidate, fileSystem, true)
    .catch(() => false);
}

async function readStableLock(
  lockPath: string,
  fileSystem: LifetimeFileSystem,
): Promise<StableLockRecord | null> {
  try {
    const source = await readLifetimeSource(lockPath, fileSystem, MAX_LOCK_BYTES);
    const record = parseLockRecord(source.content.toString("utf8"));
    return record ? { record, snapshot: source.snapshot } : null;
  } catch {
    return null;
  }
}

function leaseMatches(record: LifetimeLockRecord, lease: LifetimeWriterLease): boolean {
  return record.schemaVersion === lease.schemaVersion &&
    record.pid === lease.pid &&
    record.nonce === lease.nonce;
}

function leaseFor(
  directory: string,
  lockPath: string,
  record: LifetimeLockRecord,
): LifetimeWriterLease {
  return { ...record, directory, lockPath };
}

async function validLeaseBoundary(
  lease: LifetimeWriterLease,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  try {
    const trusted = await validateLifetimeDirectory(lease.directory, fileSystem);
    return isLifetimeDirectChild(trusted, lease.lockPath, LIFETIME_LOCK_FILENAME) &&
      (process.platform === "win32"
        ? resolve(lease.lockPath).toLowerCase() ===
          resolve(trusted, LIFETIME_LOCK_FILENAME).toLowerCase()
        : resolve(lease.lockPath) === resolve(trusted, LIFETIME_LOCK_FILENAME));
  } catch {
    return false;
  }
}

function claimOptions(
  options: LifetimeLockOptions,
  fileSystem: LifetimeFileSystem,
): LifetimeClaimOptions {
  return {
    now: options.now,
    randomBytes: options.randomBytes,
    fileSystem,
    isClaimantPidAlive: options.isClaimantPidAlive,
    signalPid: options.signalPid,
  };
}

async function claimOwnedLock(
  lease: LifetimeWriterLease,
  current: StableLockRecord,
  fileSystem: LifetimeFileSystem,
  options: LifetimeClaimOptions = {},
): Promise<LifetimeSourceClaim | null> {
  if (!leaseMatches(current.record, lease)) return null;
  let claim: LifetimeSourceClaim;
  try {
    claim = await claimLifetimeSource(
      lease.directory,
      lease.lockPath,
      current.snapshot,
      fileSystem,
      false,
      options,
    );
  } catch {
    return null;
  }
  let keepClaim = false;
  try {
    const claimed = await readLifetimeSource(claim.witnessPath, fileSystem, MAX_LOCK_BYTES);
    const record = parseLockRecord(claimed.content.toString("utf8"));
    if (!record || !leaseMatches(record, lease)) return null;
    keepClaim = true;
    return claim;
  } catch {
    return null;
  } finally {
    if (!keepClaim) {
      await releaseLifetimeSourceClaim(claim, fileSystem).catch(() => undefined);
    }
  }
}

async function createWriterLock(
  directory: string,
  lockPath: string,
  record: LifetimeLockRecord,
  fileSystem: LifetimeFileSystem,
  options: LifetimeClaimOptions,
): Promise<CreateResult> {
  const anchorPath = resolve(
    directory,
    `.sdl-observability-lifetime.create.${record.nonce}`,
  );
  const anchorContent = serializeCreateAnchor(record);
  let handle: FileHandle | undefined;
  let anchorIdentity: LifetimeSourceSnapshot | undefined;
  let claim: LifetimeSourceClaim | undefined;
  let lockIdentity: LifetimeSourceSnapshot | undefined;
  let writer = false;
  try {
    try {
      handle = await fileSystem.open(anchorPath, "wx", 0o600);
    } catch {
      return { status: "failure" };
    }
    anchorIdentity = identitySnapshot(await handle.stat({ bigint: true }));
    if (process.platform === "win32") await handle.chmod(0o600).catch(() => undefined);
    else await handle.chmod(0o600);
    await handle.writeFile(anchorContent, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const anchor = await readLifetimeSource(anchorPath, fileSystem, MAX_LOCK_BYTES);
    if (
      !sameLifetimeIdentity(anchor.snapshot, anchorIdentity) ||
      anchor.content.toString("utf8") !== anchorContent
    ) {
      return { status: "failure" };
    }
    try {
      claim = await claimLifetimeSource(
        directory,
        anchorPath,
        anchor.snapshot,
        fileSystem,
        false,
        options,
      );
    } catch (error) {
      const code = lifetimeClaimErrorCode(error);
      return { status: code === "busy" || code === "mismatch" ? "contended" : "failure" };
    }

    try {
      handle = await fileSystem.open(lockPath, "wx", 0o600);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST"
        ? { status: "exists" }
        : { status: "failure" };
    }
    lockIdentity = identitySnapshot(await handle.stat({ bigint: true }));
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
    const lease = leaseFor(directory, lockPath, record);
    if (!stored || !sameLifetimeIdentity(stored.snapshot, lockIdentity) ||
        !leaseMatches(stored.record, lease)) {
      return { status: "failure" };
    }
    writer = true;
    return { status: "writer", lease };
  } catch {
    return { status: "failure" };
  } finally {
    await closeQuietly(handle);
    if (!writer) {
      await cleanupExactCreatedPath(
        lockPath,
        lockIdentity,
        resolve(directory, `.sdl-observability-lifetime.create-lock.${record.nonce}`),
        fileSystem,
      );
    }
    if (claim) await releaseLifetimeSourceClaim(claim, fileSystem).catch(() => undefined);
    await cleanupExactCreatedPath(
      anchorPath,
      anchorIdentity,
      `${anchorPath}.cleanup`,
      fileSystem,
    );
  }
}

function defaultPidLiveness(
  pid: number,
  signalPid: (pid: number, signal: 0) => void,
): boolean {
  try {
    signalPid(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
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
    const directoryStat = await fileSystem.lstat(trustedDirectory, { bigint: true });
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return readOnly("invalidLock");
    }
  } catch {
    return readOnly("ioFailure");
  }

  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return readOnly("ioFailure");
  let record: LifetimeLockRecord;
  try {
    const nonceBytes = (options.randomBytes ?? nodeRandomBytes)(16);
    if (nonceBytes.length !== 16) return readOnly("ioFailure");
    record = {
      schemaVersion: 1,
      pid,
      createdAt: strictIso((options.now ?? (() => new Date()))()),
      nonce: nonceBytes.toString("hex"),
    };
  } catch {
    return readOnly("ioFailure");
  }

  const lockPath = resolve(trustedDirectory, LIFETIME_LOCK_FILENAME);
  const sharedClaimOptions = claimOptions(options, fileSystem);
  try {
    const startup = await settleLifetimeClaim(trustedDirectory, sharedClaimOptions, false);
    if (startup !== "available") {
      return readOnly(startup === "busy" ? "contended" : "invalidLock");
    }
  } catch {
    return readOnly("ioFailure");
  }
  let initial: CreateResult;
  try {
    initial = await createWriterLock(
      trustedDirectory,
      lockPath,
      record,
      fileSystem,
      sharedClaimOptions,
    );
  } catch {
    return readOnly("ioFailure");
  }
  if (initial.status === "writer") return { mode: "writer", lease: initial.lease };
  if (initial.status === "failure") return readOnly("ioFailure");
  if (initial.status === "contended") return readOnly("contended");

  const existing = await readStableLock(lockPath, fileSystem);
  if (!existing) return readOnly("invalidLock");
  let alive: boolean;
  try {
    alive = options.isPidAlive
      ? await options.isPidAlive(existing.record.pid)
      : defaultPidLiveness(
          existing.record.pid,
          options.signalPid ?? ((targetPid, signal) => process.kill(targetPid, signal)),
        );
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
        expectedSource: existing.snapshot,
        waitForClaim: false,
        isClaimantPidAlive: options.isClaimantPidAlive,
        signalPid: options.signalPid,
      },
    );
  } catch (error) {
    const claimCode = lifetimeClaimErrorCode(error);
    return readOnly(claimCode === "busy" || claimCode === "mismatch"
      ? "contended"
      : "ioFailure");
  }

  let retry: CreateResult;
  try {
    retry = await createWriterLock(
      trustedDirectory,
      lockPath,
      record,
      fileSystem,
      sharedClaimOptions,
    );
  } catch {
    return readOnly("ioFailure");
  }
  return retry.status === "writer"
    ? { mode: "writer", lease: retry.lease }
    : readOnly(retry.status === "exists" || retry.status === "contended"
      ? "contended"
      : "ioFailure");
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

/** Refresh only the hard-linked exact owner; replacements remain untouched. */
export async function refreshLifetimeLease(
  lease: LifetimeWriterLease,
  options: Pick<LifetimeLockOptions, "now" | "fileSystem"> = {},
): Promise<boolean> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  if (!await validLeaseBoundary(lease, fileSystem)) return false;
  const current = await readStableLock(lease.lockPath, fileSystem);
  if (!current) return false;
  const claim = await claimOwnedLock(lease, current, fileSystem);
  if (!claim) return false;
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(
      claim.witnessPath,
      constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const claimed = parseLockRecord(await handle.readFile({ encoding: "utf8" }));
    if (!claimed || !leaseMatches(claimed, lease)) return false;
    const refreshed: LifetimeLockRecord = {
      schemaVersion: 1,
      pid: claimed.pid,
      createdAt: strictIso((options.now ?? (() => new Date()))()),
      nonce: claimed.nonce,
    };
    await writeAtStart(handle, serializeLock(refreshed));
    await handle.sync();
    await handle.close();
    handle = undefined;
    const claimAfter = await readLifetimeSource(claim.witnessPath, fileSystem, MAX_LOCK_BYTES);
    const sourceAfter = await readLifetimeSource(lease.lockPath, fileSystem, MAX_LOCK_BYTES);
    const stored = parseLockRecord(sourceAfter.content.toString("utf8"));
    return sameLifetimeSource(claimAfter.snapshot, sourceAfter.snapshot) &&
      stored !== null &&
      leaseMatches(stored, lease) &&
      stored.createdAt === refreshed.createdAt;
  } catch {
    return false;
  } finally {
    await closeQuietly(handle);
    await releaseLifetimeSourceClaim(claim, fileSystem).catch(() => undefined);
  }
}

/** Rename and delete only the hard-linked exact owner entry. */
export async function releaseLifetimeLease(
  lease: LifetimeWriterLease,
  options: Pick<LifetimeLockOptions, "fileSystem"> = {},
): Promise<boolean> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  if (!await validLeaseBoundary(lease, fileSystem)) return false;
  const current = await readStableLock(lease.lockPath, fileSystem);
  if (!current) return false;
  const claim = await claimOwnedLock(lease, current, fileSystem);
  if (!claim) return false;
  const candidatePath = resolve(
    lease.directory,
    `.sdl-observability-lifetime.release.${claim.record.nonce}`,
  );
  try {
    try {
      await fileSystem.lstat(candidatePath, { bigint: true });
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    if (!await moveClaimedLifetimeSource(claim, candidatePath, fileSystem)) return false;
    const moved = await readLifetimeSource(candidatePath, fileSystem, MAX_LOCK_BYTES);
    const record = parseLockRecord(moved.content.toString("utf8"));
    if (!record || !leaseMatches(record, lease)) return false;
    await fileSystem.unlink(candidatePath);
    return true;
  } catch {
    return false;
  } finally {
    await releaseLifetimeSourceClaim(claim, fileSystem).catch(() => undefined);
  }
}
