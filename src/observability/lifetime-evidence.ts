import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as nodeFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

export const MAX_LIFETIME_EVIDENCE_FILES = 8;
export const LIFETIME_EVIDENCE_PREFIX = "sdl-observability-lifetime.evidence.";
export const LIFETIME_CLAIM_FILENAME = "sdl-observability-lifetime.claim";
const MAX_EVIDENCE_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CLAIM_BYTES = 16 * 1024;
const MAX_LIFETIME_AUXILIARIES = 32;
const MAX_LIFETIME_AUXILIARY_SCAN = 256;
const CLAIM_WAIT_ATTEMPTS = 1_000;
const CLAIM_RACE_RECHECK_ATTEMPTS = 8;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX_128 = /^[0-9a-f]{32}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]*)$/;

export interface LifetimeEvidenceLabel {
  readonly kind: "lock" | "publication";
  readonly eligibility: "validated-supported" | "protected-unknown-newer";
}

export interface LifetimeFileSystem {
  readonly open: typeof nodeFs.open;
  readonly lstat: typeof nodeFs.lstat;
  readonly readFile: typeof nodeFs.readFile;
  readonly readdir: typeof nodeFs.readdir;
  readonly link: typeof nodeFs.link;
  readonly rename: typeof nodeFs.rename;
  readonly unlink: typeof nodeFs.unlink;
}

export type LifetimeFileSystemOverrides = Partial<LifetimeFileSystem>;

export interface LifetimeSourceSnapshot {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly sha256: string;
}

interface LifetimeClaimRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly createdAt: string;
  readonly nonce: string;
  readonly source: LifetimeSourceSnapshot;
}

export interface LifetimeSourceClaim {
  readonly directory: string;
  readonly sourcePath: string;
  readonly claimPath: string;
  readonly recordPath: string;
  readonly witnessPath: string;
  readonly record: LifetimeClaimRecord;
  readonly metadataSnapshot: LifetimeSourceSnapshot;
  readonly sourceSnapshot: LifetimeSourceSnapshot;
}

export interface LifetimeClaimOptions {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly fileSystem?: LifetimeFileSystemOverrides;
  readonly isClaimantPidAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly signalPid?: (pid: number, signal: 0) => void;
}

export interface LifetimeEvidenceOptions extends LifetimeClaimOptions {
  readonly expectedSource?: LifetimeSourceSnapshot;
  readonly waitForClaim?: boolean;
}

interface EvidenceEntry {
  readonly name: string;
  readonly path: string;
  readonly timestamp: number;
  readonly eligibility: LifetimeEvidenceLabel["eligibility"];
  readonly snapshot: LifetimeSourceSnapshot;
}

interface SimpleAuxiliaryRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly createdAt: string;
  readonly nonce: string;
}

interface CreateAuxiliaryRecord extends SimpleAuxiliaryRecord {
  readonly lock: SimpleAuxiliaryRecord;
  readonly lockSha256: string;
}

interface AuxiliaryEntry {
  readonly name: string;
  readonly logicalName: string;
  readonly path: string;
  readonly snapshot: LifetimeSourceSnapshot;
  readonly claim: LifetimeClaimRecord | null;
  readonly simple: SimpleAuxiliaryRecord | null;
  readonly create: CreateAuxiliaryRecord | null;
  readonly nonce: string | null;
  readonly kind: "create" | "create-witness" | "created-lock" | "record" | "witness" |
    "claim-artifact" | "moved-source" | "evidence-delete";
}

type ExistingClaimOutcome = "recovered" | "raced" | "live" | "invalid";
export type LifetimeClaimAvailability = "available" | "busy" | "invalid";

const EVIDENCE_NAME = /^sdl-observability-lifetime\.evidence\.v1\.(validated-supported|protected-unknown-newer)\.(lock|publication)\.([0-9a-z]{11})\.([0-9a-f]{32})\.json$/;
const AUXILIARY_PREFIX = ".sdl-observability-lifetime.";
const CREATE_AUXILIARY = /^\.sdl-observability-lifetime\.create\.([0-9a-f]{32})$/;
const CREATE_WITNESS_AUXILIARY = /^\.sdl-observability-lifetime\.create-source\.([0-9a-f]{32})$/;
const CREATED_LOCK_AUXILIARY = /^\.sdl-observability-lifetime\.create-lock\.([0-9a-f]{32})$/;
const RECORD_AUXILIARY = /^\.sdl-observability-lifetime\.claim-record\.([0-9a-f]{32})\.json$/;
const WITNESS_AUXILIARY = /^\.sdl-observability-lifetime\.claim-source\.([0-9a-f]{32})$/;
const CLAIM_AUXILIARY = /^\.sdl-observability-lifetime\.claim-(?:cleanup|recovery-witness|recovery-moved)\.([0-9a-f]{32})$/;
const CLAIM_CLEANUP_AUXILIARY = /^\.sdl-observability-lifetime\.claim-cleanup\.([0-9a-f]{32})$/;
const MOVED_SOURCE_AUXILIARY = /^\.sdl-observability-lifetime\.(?:release|aux-delete)\.([0-9a-f]{32})$/;
const DELETE_AUXILIARY_PREFIX = ".sdl-observability-lifetime.delete.";
const NORMALIZE_AUXILIARY_SUFFIX = /\.normalize\.[0-9a-f]{32}$/;

export function resolveLifetimeFileSystem(
  overrides: LifetimeFileSystemOverrides = {},
): LifetimeFileSystem {
  return {
    open: overrides.open ?? nodeFs.open,
    lstat: overrides.lstat ?? nodeFs.lstat,
    readFile: overrides.readFile ?? nodeFs.readFile,
    readdir: overrides.readdir ?? nodeFs.readdir,
    link: overrides.link ?? nodeFs.link,
    rename: overrides.rename ?? nodeFs.rename,
    unlink: overrides.unlink ?? nodeFs.unlink,
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export async function validateLifetimeDirectory(
  directory: string,
  fileSystem: LifetimeFileSystem,
): Promise<string> {
  const trusted = resolve(directory);
  const stat = await fileSystem.lstat(trusted, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Lifetime directory must be a regular non-symlink directory");
  }
  return trusted;
}

function directChildPath(directory: string, path: string, label: string): string {
  const candidate = resolve(path);
  if (!samePath(dirname(candidate), directory)) {
    throw new Error(`${label} must remain directly inside the trusted directory`);
  }
  return candidate;
}

export function isLifetimeDirectChild(
  directory: string,
  path: string,
  expectedName?: string,
): boolean {
  const trusted = resolve(directory);
  const candidate = resolve(path);
  return samePath(dirname(candidate), trusted) &&
    (expectedName === undefined || basename(candidate) === expectedName);
}

function regularFile(stat: BigIntStats, label: string, maxBytes: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (stat.size > BigInt(maxBytes)) throw new Error(`${label} exceeds its size limit`);
}

function statSnapshot(stat: BigIntStats, content: Buffer): LifetimeSourceSnapshot {
  return {
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
    size: Number(stat.size),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function sameLifetimeSource(
  left: LifetimeSourceSnapshot,
  right: LifetimeSourceSnapshot,
): boolean {
  const identityMatches = left.ino === "0" && right.ino === "0"
    ? true
    : left.dev === right.dev && left.ino === right.ino;
  return identityMatches && left.size === right.size && left.sha256 === right.sha256;
}

export function sameLifetimeIdentity(
  left: LifetimeSourceSnapshot,
  right: LifetimeSourceSnapshot,
): boolean {
  return left.ino !== "0" && right.ino !== "0"
    ? left.dev === right.dev && left.ino === right.ino
    : sameLifetimeSource(left, right);
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

/** Read one stable regular source without following a final-component symlink. */
export async function readLifetimeSource(
  path: string,
  fileSystem: LifetimeFileSystem,
  maxBytes = MAX_EVIDENCE_SOURCE_BYTES,
): Promise<{ readonly content: Buffer; readonly snapshot: LifetimeSourceSnapshot }> {
  const before = await fileSystem.lstat(path, { bigint: true });
  regularFile(before, "Lifetime source", maxBytes);
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    regularFile(opened, "Lifetime source", maxBytes);
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) {
      throw new Error("Lifetime source changed while opening");
    }
    const content = await handle.readFile();
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await fileSystem.lstat(path, { bigint: true });
    const snapshot = statSnapshot(opened, content);
    if (
      afterOpen.dev !== opened.dev ||
      afterOpen.ino !== opened.ino ||
      afterOpen.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== opened.size
    ) {
      throw new Error("Lifetime source changed while reading");
    }
    return { content, snapshot };
  } finally {
    await closeQuietly(handle);
  }
}

function strictIso(now: () => Date): string {
  const value = now().toISOString();
  if (!ISO_TIMESTAMP.test(value)) throw new Error("Invalid lifetime claim timestamp");
  return value;
}

function serializeClaim(record: LifetimeClaimRecord): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    pid: record.pid,
    createdAt: record.createdAt,
    nonce: record.nonce,
    source: {
      dev: record.source.dev,
      ino: record.source.ino,
      size: record.source.size,
      sha256: record.source.sha256,
    },
  });
}

function parseSnapshot(value: unknown): LifetimeSourceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(source)) !== JSON.stringify(["dev", "ino", "size", "sha256"]) ||
    typeof source.dev !== "string" ||
    !DECIMAL_IDENTITY.test(source.dev) ||
    typeof source.ino !== "string" ||
    !DECIMAL_IDENTITY.test(source.ino) ||
    !Number.isSafeInteger(source.size) ||
    Number(source.size) < 0 ||
    typeof source.sha256 !== "string" ||
    !SHA_256.test(source.sha256)
  ) {
    return null;
  }
  return {
    dev: source.dev,
    ino: source.ino,
    size: Number(source.size),
    sha256: source.sha256,
  };
}

function parseClaim(content: Buffer): LifetimeClaimRecord | null {
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const source = parseSnapshot(value.source);
    if (
      JSON.stringify(Object.keys(value)) !==
        JSON.stringify(["schemaVersion", "pid", "createdAt", "nonce", "source"]) ||
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.createdAt !== "string" ||
      !ISO_TIMESTAMP.test(value.createdAt) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      typeof value.nonce !== "string" ||
      !HEX_128.test(value.nonce) ||
      !source
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      pid: Number(value.pid),
      createdAt: value.createdAt,
      nonce: value.nonce,
      source,
    };
  } catch {
    return null;
  }
}

function parseSimpleAuxiliaryValue(value: unknown): SimpleAuxiliaryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record)) !==
      JSON.stringify(["schemaVersion", "pid", "createdAt", "nonce"]) ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    typeof record.createdAt !== "string" ||
    !ISO_TIMESTAMP.test(record.createdAt) ||
    new Date(record.createdAt).toISOString() !== record.createdAt ||
    typeof record.nonce !== "string" ||
    !HEX_128.test(record.nonce)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    pid: Number(record.pid),
    createdAt: record.createdAt,
    nonce: record.nonce,
  };
}

function parseSimpleAuxiliary(content: Buffer): SimpleAuxiliaryRecord | null {
  try {
    return parseSimpleAuxiliaryValue(JSON.parse(content.toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

function parseCreateAuxiliary(content: Buffer): CreateAuxiliaryRecord | null {
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(value)) !== JSON.stringify([
        "schemaVersion",
        "pid",
        "createdAt",
        "nonce",
        "lock",
        "lockSha256",
      ]) ||
      typeof value.lockSha256 !== "string" ||
      !SHA_256.test(value.lockSha256)
    ) {
      return null;
    }
    const simple = parseSimpleAuxiliaryValue({
      schemaVersion: value.schemaVersion,
      pid: value.pid,
      createdAt: value.createdAt,
      nonce: value.nonce,
    });
    const lock = parseSimpleAuxiliaryValue(value.lock);
    if (!simple || !lock || lock.nonce !== simple.nonce) return null;
    const lockSha256 = createHash("sha256")
      .update(JSON.stringify(lock))
      .digest("hex");
    if (lockSha256 !== value.lockSha256) return null;
    return { ...simple, lock, lockSha256 };
  } catch {
    return null;
  }
}

function claimError(code: "busy" | "mismatch" | "unsupported", message: string): Error {
  return Object.assign(new Error(message), { lifetimeClaimCode: code });
}

export function lifetimeClaimErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "lifetimeClaimCode" in error
    ? String((error as { lifetimeClaimCode: unknown }).lifetimeClaimCode)
    : undefined;
}

function recordPath(directory: string, nonce: string): string {
  return resolve(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`);
}

function witnessPath(directory: string, nonce: string): string {
  return resolve(directory, `.sdl-observability-lifetime.claim-source.${nonce}`);
}

async function pathAbsent(path: string, fileSystem: LifetimeFileSystem): Promise<boolean> {
  try {
    await fileSystem.lstat(path, { bigint: true });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function fixedClaimStat(
  path: string,
  fileSystem: LifetimeFileSystem,
): Promise<BigIntStats | "absent" | "invalid"> {
  for (let attempt = 0; attempt < CLAIM_RACE_RECHECK_ATTEMPTS; attempt++) {
    try {
      const stat = await fileSystem.lstat(path, { bigint: true });
      regularFile(stat, "Lifetime claim", MAX_CLAIM_BYTES);
      return stat;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "absent";
      if (code !== "EPERM" && code !== "EACCES") return "invalid";
      if (attempt + 1 < CLAIM_RACE_RECHECK_ATTEMPTS) await waitOneMillisecond();
    }
  }
  return "invalid";
}

async function writeClosedFile(
  path: string,
  content: string,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(path, "wx", 0o600);
    if (process.platform === "win32") await handle.chmod(0o600).catch(() => undefined);
    else await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } finally {
    await closeQuietly(handle);
  }
}

async function unlinkExact(
  path: string,
  expected: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
  identityOnly = false,
): Promise<void> {
  try {
    const current = await readLifetimeSource(path, fileSystem, MAX_EVIDENCE_SOURCE_BYTES);
    const matches = identityOnly
      ? sameLifetimeIdentity(current.snapshot, expected)
      : sameLifetimeSource(current.snapshot, expected);
    if (matches) await fileSystem.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function restoreMovedReplacement(
  movedPath: string,
  sourcePath: string,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  try {
    await fileSystem.link(movedPath, sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  const moved = await readLifetimeSource(movedPath, fileSystem);
  const restored = await readLifetimeSource(sourcePath, fileSystem);
  if (sameLifetimeSource(moved.snapshot, restored.snapshot)) {
    await fileSystem.unlink(movedPath);
  }
}

export async function removeExactLifetimeSource(
  claimPath: string,
  expected: LifetimeSourceSnapshot,
  candidatePath: string,
  fileSystem: LifetimeFileSystem,
  identityOnly = false,
): Promise<boolean> {
  try {
    await fileSystem.rename(claimPath, candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = await readLifetimeSource(candidatePath, fileSystem, MAX_CLAIM_BYTES);
  const matches = identityOnly
    ? sameLifetimeIdentity(moved.snapshot, expected)
    : sameLifetimeSource(moved.snapshot, expected);
  if (!matches) {
    await restoreMovedReplacement(candidatePath, claimPath, fileSystem);
    return false;
  }
  await fileSystem.unlink(candidatePath);
  return true;
}

function strictPidAlive(
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

async function claimantAlive(
  pid: number,
  options: LifetimeClaimOptions,
): Promise<boolean> {
  if (options.isClaimantPidAlive) return options.isClaimantPidAlive(pid);
  return strictPidAlive(
    pid,
    options.signalPid ?? ((targetPid, signal) => process.kill(targetPid, signal)),
  );
}

function classifyAuxiliary(
  directory: string,
  name: string,
  source: Awaited<ReturnType<typeof readLifetimeSource>>,
): AuxiliaryEntry | null {
  const normalization = NORMALIZE_AUXILIARY_SUFFIX.exec(name);
  const logicalName = normalization
    ? name.slice(0, normalization.index)
    : name.endsWith(".cleanup-next")
      ? name.slice(0, -".cleanup-next".length)
      : name.endsWith(".cleanup")
        ? name.slice(0, -".cleanup".length)
        : name;
  const create = CREATE_AUXILIARY.exec(logicalName);
  if (create) {
    const createRecord = parseCreateAuxiliary(source.content);
    if (!createRecord || createRecord.nonce !== create[1]) return null;
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim: null,
      simple: null,
      create: createRecord,
      nonce: createRecord.nonce,
      kind: "create",
    };
  }
  const record = RECORD_AUXILIARY.exec(logicalName);
  const createWitness = CREATE_WITNESS_AUXILIARY.exec(logicalName);
  if (createWitness) {
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim: null,
      simple: null,
      create: null,
      nonce: createWitness[1] ?? null,
      kind: "create-witness",
    };
  }
  const createdLock = CREATED_LOCK_AUXILIARY.exec(logicalName);
  if (createdLock) {
    const simple = parseSimpleAuxiliary(source.content);
    if (!simple || simple.nonce !== createdLock[1]) return null;
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim: null,
      simple,
      create: null,
      nonce: simple.nonce,
      kind: "created-lock",
    };
  }
  if (record) {
    const claim = parseClaim(source.content);
    if (!claim || claim.nonce !== record[1]) return null;
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim,
      simple: null,
      create: null,
      nonce: claim.nonce,
      kind: "record",
    };
  }
  const witness = WITNESS_AUXILIARY.exec(logicalName);
  if (witness) {
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim: null,
      simple: null,
      create: null,
      nonce: witness[1] ?? null,
      kind: "witness",
    };
  }
  const claimArtifact = CLAIM_AUXILIARY.exec(logicalName);
  if (claimArtifact) {
    const claim = parseClaim(source.content);
    if (!claim || claim.nonce !== claimArtifact[1]) return null;
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim,
      simple: null,
      create: null,
      nonce: claim.nonce,
      kind: "claim-artifact",
    };
  }
  const moved = MOVED_SOURCE_AUXILIARY.exec(logicalName);
  if (moved) {
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim: null,
      simple: null,
      create: null,
      nonce: moved[1] ?? null,
      kind: "moved-source",
    };
  }
  if (logicalName.startsWith(DELETE_AUXILIARY_PREFIX)) {
    const evidenceName = logicalName.slice(DELETE_AUXILIARY_PREFIX.length);
    const evidence = EVIDENCE_NAME.exec(evidenceName);
    if (!evidence || evidence[1] !== "validated-supported") return null;
    return {
      name,
      logicalName,
      path: resolve(directory, name),
      snapshot: source.snapshot,
      claim: null,
      simple: null,
      create: null,
      nonce: null,
      kind: "evidence-delete",
    };
  }
  return null;
}

function sameClaimRecord(left: LifetimeClaimRecord, right: LifetimeClaimRecord): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.pid === right.pid &&
    left.createdAt === right.createdAt &&
    left.nonce === right.nonce &&
    sameLifetimeSource(left.source, right.source);
}

async function matchingClaimCleanup(
  directory: string,
  record: LifetimeClaimRecord,
  fixedSnapshot: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  const cleanupPath = directChildPath(
    directory,
    resolve(directory, `.sdl-observability-lifetime.claim-cleanup.${record.nonce}`),
    "Lifetime claim cleanup",
  );
  try {
    await fileSystem.lstat(cleanupPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const cleanup = await readLifetimeSource(cleanupPath, fileSystem, MAX_CLAIM_BYTES);
    const cleanupRecord = parseClaim(cleanup.content);
    return cleanupRecord !== null &&
      sameClaimRecord(cleanupRecord, record) &&
      sameLifetimeSource(cleanup.snapshot, fixedSnapshot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      (code === "ENOENT" || code === "EPERM" || code === "EACCES") &&
      await pathAbsent(cleanupPath, fileSystem)
    ) {
      return true;
    }
    throw error;
  }
}

async function matchingPresentClaimCleanup(
  directory: string,
  record: LifetimeClaimRecord,
  fixedSnapshot: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  const cleanupPath = directChildPath(
    directory,
    resolve(directory, `.sdl-observability-lifetime.claim-cleanup.${record.nonce}`),
    "Lifetime claim cleanup",
  );
  try {
    const cleanup = await readLifetimeSource(cleanupPath, fileSystem, MAX_CLAIM_BYTES);
    const cleanupRecord = parseClaim(cleanup.content);
    return cleanupRecord !== null &&
      sameClaimRecord(cleanupRecord, record) &&
      sameLifetimeSource(cleanup.snapshot, fixedSnapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function matchingInitialClaimCleanup(
  directory: string,
  fixedStat: BigIntStats,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  if (fixedStat.ino === 0n) return false;
  const names = (await fileSystem.readdir(directory, { encoding: "utf8" }))
    .filter((name) => CLAIM_CLEANUP_AUXILIARY.test(name))
    .sort();
  if (names.length > MAX_LIFETIME_AUXILIARY_SCAN) return false;
  for (const name of names) {
    const match = CLAIM_CLEANUP_AUXILIARY.exec(name);
    const nonce = match?.[1];
    if (!nonce) continue;
    try {
      const cleanup = await readLifetimeSource(resolve(directory, name), fileSystem, MAX_CLAIM_BYTES);
      const cleanupRecord = parseClaim(cleanup.content);
      if (!cleanupRecord || cleanupRecord.nonce !== nonce) continue;
      const durable = await readLifetimeSource(recordPath(directory, nonce), fileSystem, MAX_CLAIM_BYTES);
      const durableRecord = parseClaim(durable.content);
      if (
        durableRecord &&
        sameClaimRecord(cleanupRecord, durableRecord) &&
        sameLifetimeSource(cleanup.snapshot, durable.snapshot) &&
        cleanup.snapshot.dev === fixedStat.dev.toString(10) &&
        cleanup.snapshot.ino === fixedStat.ino.toString(10)
      ) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

function sameSimpleRecord(left: SimpleAuxiliaryRecord, right: SimpleAuxiliaryRecord): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.pid === right.pid &&
    left.createdAt === right.createdAt &&
    left.nonce === right.nonce;
}

function sourceGroupKey(source: LifetimeSourceSnapshot): string {
  return source.ino !== "0"
    ? `inode:${source.dev}:${source.ino}`
    : `content:${source.size}:${source.sha256}`;
}

async function removeValidatedAuxiliary(
  entry: AuxiliaryEntry,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  const nextSuffix = entry.name.endsWith(".cleanup") ? ".cleanup-next" : ".cleanup";
  const candidate = resolve(
    dirname(entry.path),
    `${entry.logicalName}${nextSuffix}`,
  );
  if (!await pathAbsent(candidate, fileSystem)) return false;
  return removeExactLifetimeSource(entry.path, entry.snapshot, candidate, fileSystem);
}

function normalizationCandidatePath(directory: string, entry: AuxiliaryEntry): string {
  // Bind a bounded recovery slot to this exact physical alias, so two occupied
  // legacy cleanup names never have to use each other as rename candidates.
  const token = createHash("sha256")
    .update(entry.name)
    .update("\0")
    .update(entry.snapshot.dev)
    .update("\0")
    .update(entry.snapshot.ino)
    .update("\0")
    .update(entry.snapshot.sha256)
    .digest("hex")
    .slice(0, 32);
  return directChildPath(
    directory,
    resolve(directory, `${entry.logicalName}.normalize.${token}`),
    "Lifetime auxiliary normalization",
  );
}

async function normalizeCanonicalAuxiliary(
  canonical: AuxiliaryEntry,
  source: AuxiliaryEntry,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  try {
    await fileSystem.link(source.path, canonical.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  const restored = await readLifetimeSource(canonical.path, fileSystem, MAX_EVIDENCE_SOURCE_BYTES);
  return sameLifetimeSource(restored.snapshot, canonical.snapshot);
}

async function restoreEvidenceDeletion(
  directory: string,
  entry: AuxiliaryEntry,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  const targetName = entry.logicalName.slice(DELETE_AUXILIARY_PREFIX.length);
  const target = directChildPath(directory, resolve(directory, targetName), "Evidence restore");
  if (!await pathAbsent(target, fileSystem)) return false;
  try {
    await fileSystem.rename(entry.path, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const restored = await readLifetimeSource(target, fileSystem);
  if (sameLifetimeSource(restored.snapshot, entry.snapshot)) return true;
  await restoreMovedReplacement(target, entry.path, fileSystem);
  return false;
}

async function recoverStrandedAuxiliaries(
  directory: string,
  fileSystem: LifetimeFileSystem,
  options: LifetimeClaimOptions,
  ignoredNames: ReadonlySet<string>,
): Promise<LifetimeClaimAvailability> {
  const allNames = (await fileSystem.readdir(directory, { encoding: "utf8" }))
    .filter((name) => name.startsWith(AUXILIARY_PREFIX) && !ignoredNames.has(name))
    .sort();
  if (allNames.length === 0) return "available";
  if (allNames.length > MAX_LIFETIME_AUXILIARY_SCAN) return "invalid";
  const entries: AuxiliaryEntry[] = [];
  const logicalEntries = new Map<string, AuxiliaryEntry>();
  try {
    for (const name of allNames) {
      const path = directChildPath(directory, resolve(directory, name), "Lifetime auxiliary");
      const source = await readLifetimeSource(path, fileSystem, MAX_EVIDENCE_SOURCE_BYTES);
      const entry = classifyAuxiliary(directory, name, source);
      if (!entry) return "invalid";
      const existing = logicalEntries.get(entry.logicalName);
      if (existing && (
        existing.kind !== entry.kind ||
        existing.nonce !== entry.nonce ||
        !sameLifetimeSource(existing.snapshot, entry.snapshot)
      )) return "invalid";
      logicalEntries.set(entry.logicalName, entry);
      entries.push(entry);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "EPERM" || code === "EACCES"
      ? "busy"
      : "invalid";
  }

  const claims = new Map<string, LifetimeClaimRecord>();
  for (const entry of entries) {
    if (entry.kind !== "record" || !entry.claim) continue;
    const existing = claims.get(entry.claim.nonce);
    if (existing && !sameClaimRecord(existing, entry.claim)) return "invalid";
    claims.set(entry.claim.nonce, entry.claim);
  }
  for (const entry of entries) {
    if (entry.kind === "claim-artifact") {
      const durable = entry.nonce ? claims.get(entry.nonce) : undefined;
      if (!durable || !entry.claim || !sameClaimRecord(durable, entry.claim)) {
        return "invalid";
      }
    }
    if (entry.kind === "witness" || entry.kind === "moved-source") {
      const claim = entry.nonce ? claims.get(entry.nonce) : undefined;
      if (!claim || !sameLifetimeIdentity(entry.snapshot, claim.source)) {
        return "invalid";
      }
    }
    if (entry.kind === "create") {
      const referringClaim = [...claims.values()].find((claim) =>
        sameLifetimeIdentity(entry.snapshot, claim.source));
      if (referringClaim && referringClaim.pid !== entry.create?.pid) {
        return "invalid";
      }
    }
    if (entry.kind === "create-witness") {
      const anchor = entries.find((candidate) =>
        candidate.kind === "create" && candidate.nonce === entry.nonce);
      if (!anchor || !sameLifetimeIdentity(anchor.snapshot, entry.snapshot)) return "invalid";
    }
    if (entry.kind === "created-lock") {
      const anchor = entries.find((candidate) =>
        candidate.kind === "create" && candidate.nonce === entry.nonce);
      if (
        !anchor?.create ||
        !entry.simple ||
        !sameSimpleRecord(anchor.create.lock, entry.simple) ||
        anchor.create.lockSha256 !== entry.snapshot.sha256
      ) {
        return "invalid";
      }
    }
  }

  const pids = new Set<number>();
  for (const entry of entries) {
    if (entry.claim) pids.add(entry.claim.pid);
    if (entry.create) pids.add(entry.create.pid);
    if (entry.simple) pids.add(entry.simple.pid);
  }
  try {
    for (const pid of pids) {
      if (await claimantAlive(pid, options)) return "busy";
    }
  } catch {
    return "invalid";
  }

  const recoveryEntries: AuxiliaryEntry[] = [];
  const aliasesByCanonical = new Map<AuxiliaryEntry, AuxiliaryEntry[]>();
  const normalizationByCanonical = new Map<AuxiliaryEntry, AuxiliaryEntry>();
  const aliasesByLogicalName = Map.groupBy(entries, (entry) => entry.logicalName);
  for (const aliases of aliasesByLogicalName.values()) {
    const sorted = [...aliases].sort((left, right) => left.name.localeCompare(right.name));
    const storedCanonical = aliases.find((entry) => entry.name === entry.logicalName);
    const representative = storedCanonical ?? sorted[0];
    if (!representative) return "invalid";
    // An alias-only set first restores its absent base. The synthetic entry
    // lets dependency grouping and mutation accounting include that base.
    const canonical = storedCanonical ?? (aliases.length > 1
      ? {
          ...representative,
          name: representative.logicalName,
          path: resolve(directory, representative.logicalName),
        }
      : representative);
    recoveryEntries.push(canonical);
    aliasesByCanonical.set(canonical, storedCanonical
      ? sorted.filter((entry) => entry !== storedCanonical)
      : aliases.length > 1 ? sorted : []);
    if (!storedCanonical && aliases.length > 1) {
      normalizationByCanonical.set(canonical, representative);
    }
  }

  const createByNonce = new Map(
    recoveryEntries
      .filter((entry) => entry.kind === "create" && entry.nonce)
      .map((entry) => [entry.nonce as string, entry] as const),
  );
  const groups = new Map<string, {
    readonly entries: AuxiliaryEntry[];
    readonly aliases: AuxiliaryEntry[];
    readonly normalizations: Array<{
      readonly canonical: AuxiliaryEntry;
      readonly source: AuxiliaryEntry;
    }>;
  }>();
  for (const entry of recoveryEntries) {
    let key: string;
    if (entry.kind === "evidence-delete") {
      key = `evidence:${entry.logicalName}`;
    } else if (entry.kind === "create") {
      key = sourceGroupKey(entry.snapshot);
    } else if (entry.kind === "create-witness" || entry.kind === "created-lock") {
      const anchor = entry.nonce ? createByNonce.get(entry.nonce) : undefined;
      if (!anchor) return "invalid";
      key = sourceGroupKey(anchor.snapshot);
    } else {
      const claim = entry.claim ?? (entry.nonce ? claims.get(entry.nonce) : undefined);
      if (!claim) return "invalid";
      key = sourceGroupKey(claim.source);
    }
    const group = groups.get(key) ?? { entries: [], aliases: [], normalizations: [] };
    group.entries.push(entry);
    group.aliases.push(...(aliasesByCanonical.get(entry) ?? []));
    const normalizationSource = normalizationByCanonical.get(entry);
    if (normalizationSource) {
      group.normalizations.push({ canonical: entry, source: normalizationSource });
    }
    groups.set(key, group);
  }

  const occupiedNames = new Set(allNames);
  const plannedCandidates = new Set<string>();
  let invalidCandidatePlan = false;
  const orderedGroups = [...groups.entries()].map(([key, group]) => {
    const oldest = Math.min(...group.entries.map((entry) => {
      if (entry.claim) return Date.parse(entry.claim.createdAt);
      if (entry.create) return Date.parse(entry.create.createdAt);
      if (entry.simple) return Date.parse(entry.simple.createdAt);
      const evidenceName = entry.logicalName.slice(DELETE_AUXILIARY_PREFIX.length);
      const match = EVIDENCE_NAME.exec(evidenceName);
      return match?.[3] ? Number.parseInt(match[3], 36) : Number.MAX_SAFE_INTEGER;
    }));
    const aliasPlans = group.aliases.map((alias) => {
      const candidate = normalizationCandidatePath(directory, alias);
      if (occupiedNames.has(basename(candidate)) || plannedCandidates.has(candidate)) {
        invalidCandidatePlan = true;
      }
      plannedCandidates.add(candidate);
      return { alias, candidate };
    });
    return {
      key,
      entries: group.entries,
      aliases: group.aliases,
      aliasPlans,
      normalizations: group.normalizations,
      cost: group.normalizations.length +
        group.aliases.length * 2 +
        group.entries.reduce((cost, entry) =>
          cost + (entry.kind === "evidence-delete" ? 1 : 2), 0),
      oldest,
    };
  }).sort((left, right) => left.oldest - right.oldest || left.key.localeCompare(right.key));

  if (invalidCandidatePlan ||
    orderedGroups.some((group) => group.cost > MAX_LIFETIME_AUXILIARIES)) {
    return "invalid";
  }
  const selectedGroups: typeof orderedGroups = [];
  let selectedCount = 0;
  for (const group of orderedGroups) {
    if (selectedCount + group.cost > MAX_LIFETIME_AUXILIARIES) break;
    selectedGroups.push(group);
    selectedCount += group.cost;
  }
  if (selectedGroups.length === 0) return "invalid";

  const priority = (entry: AuxiliaryEntry) =>
    entry.kind === "witness" || entry.kind === "create-witness" ||
      entry.kind === "moved-source" ||
      entry.kind === "created-lock" ? 0
      : entry.kind === "record" ? 2
        : 1;
  try {
    for (const group of selectedGroups) {
      for (const normalization of group.normalizations) {
        if (!await normalizeCanonicalAuxiliary(
          normalization.canonical,
          normalization.source,
          fileSystem,
        )) return "busy";
      }
      for (const { alias, candidate } of group.aliasPlans) {
        if (!await pathAbsent(candidate, fileSystem) ||
          !await removeExactLifetimeSource(alias.path, alias.snapshot, candidate, fileSystem)) {
          return "busy";
        }
      }
      const orderedEntries = [...group.entries].sort((left, right) =>
        priority(left) - priority(right) || left.name.localeCompare(right.name));
      for (const entry of orderedEntries) {
        const recovered = entry.kind === "evidence-delete"
          ? await restoreEvidenceDeletion(directory, entry, fileSystem)
          : await removeValidatedAuxiliary(entry, fileSystem);
        if (!recovered) return "busy";
      }
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "busy"
      : "invalid";
  }
  return selectedGroups.length < orderedGroups.length ? "busy" : "available";
}

async function recoverExistingClaim(
  directory: string,
  fileSystem: LifetimeFileSystem,
  options: LifetimeClaimOptions,
): Promise<ExistingClaimOutcome> {
  const fixedPath = resolve(directory, LIFETIME_CLAIM_FILENAME);
  const fixedState = await fixedClaimStat(fixedPath, fileSystem);
  if (fixedState === "absent") return "raced";
  if (fixedState === "invalid") return "invalid";
  const fixedStat = fixedState;
  let fixed: Awaited<ReturnType<typeof readLifetimeSource>> | undefined;
  for (let attempt = 0; attempt < CLAIM_RACE_RECHECK_ATTEMPTS; attempt++) {
    try {
      fixed = await readLifetimeSource(fixedPath, fileSystem, MAX_CLAIM_BYTES);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "raced";
      if (code !== "EPERM" && code !== "EACCES") return "invalid";
      try {
        if (await pathAbsent(fixedPath, fileSystem) ||
            await matchingInitialClaimCleanup(directory, fixedStat, fileSystem)) return "raced";
      } catch (recheckError) {
        if ((recheckError as NodeJS.ErrnoException).code === "ENOENT") return "raced";
      }
      if (attempt + 1 < CLAIM_RACE_RECHECK_ATTEMPTS) await waitOneMillisecond();
    }
  }
  if (!fixed) return "invalid";
  const record = parseClaim(fixed.content);
  if (!record) return "invalid";
  const durableRecordPath = directChildPath(
    directory,
    recordPath(directory, record.nonce),
    "Lifetime claim record",
  );
  let durableRecord: Awaited<ReturnType<typeof readLifetimeSource>>;
  try {
    durableRecord = await readLifetimeSource(durableRecordPath, fileSystem, MAX_CLAIM_BYTES);
  } catch {
    try {
      const current = await readLifetimeSource(fixedPath, fileSystem, MAX_CLAIM_BYTES);
      if (!sameLifetimeSource(current.snapshot, fixed.snapshot)) return "raced";
      return await matchingClaimCleanup(directory, record, fixed.snapshot, fileSystem)
        ? "raced"
        : "invalid";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "raced"
        : "invalid";
    }
  }
  if (!sameLifetimeSource(fixed.snapshot, durableRecord.snapshot)) {
    return "invalid";
  }

  const durableWitnessPath = directChildPath(
    directory,
    witnessPath(directory, record.nonce),
    "Lifetime claim source witness",
  );
  let witness: Awaited<ReturnType<typeof readLifetimeSource>> | null = null;
  let cleanupWitness = false;
  try {
    witness = await readLifetimeSource(durableWitnessPath, fileSystem);
    if (!sameLifetimeIdentity(witness.snapshot, record.source)) {
      return "invalid";
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EPERM" && code !== "EACCES") {
      return "invalid";
    }
    for (let attempt = 0; attempt < CLAIM_RACE_RECHECK_ATTEMPTS; attempt++) {
      try {
        const [currentFixed, currentRecord] = await Promise.all([
          readLifetimeSource(fixedPath, fileSystem, MAX_CLAIM_BYTES),
          readLifetimeSource(durableRecordPath, fileSystem, MAX_CLAIM_BYTES),
        ]);
        if (
          sameLifetimeSource(currentFixed.snapshot, fixed.snapshot) &&
          sameLifetimeSource(currentRecord.snapshot, durableRecord.snapshot)
        ) {
          if (await matchingPresentClaimCleanup(
            directory,
            record,
            fixed.snapshot,
            fileSystem,
          )) {
            if (await claimantAlive(record.pid, options)) return "live";
            cleanupWitness = true;
            break;
          }
          if (await matchingClaimCleanup(directory, record, fixed.snapshot, fileSystem)) {
            return "raced";
          }
          // An absent witness can be the first visible step of a live claimant's
          // ordered teardown. Keep that owner authoritative while it finishes.
          if (code === "ENOENT" && await claimantAlive(record.pid, options)) return "live";
          if (attempt + 1 < CLAIM_RACE_RECHECK_ATTEMPTS) {
            await waitOneMillisecond();
            continue;
          }
          return "invalid";
        }
        return "raced";
      } catch (recheckError) {
        const recheckCode = (recheckError as NodeJS.ErrnoException).code;
        if (recheckCode === "ENOENT") return "raced";
        if (
          (recheckCode === "EPERM" || recheckCode === "EACCES") &&
          attempt + 1 < CLAIM_RACE_RECHECK_ATTEMPTS
        ) {
          await waitOneMillisecond();
          continue;
        }
        return "invalid";
      }
    }
    if (!cleanupWitness) return "invalid";
  }
  if (await claimantAlive(record.pid, options)) return "live";

  const recoveryWitnessPath = resolve(
    directory,
    `.sdl-observability-lifetime.claim-recovery-witness.${record.nonce}`,
  );
  const recoveryMovedPath = resolve(
    directory,
    `.sdl-observability-lifetime.claim-recovery-moved.${record.nonce}`,
  );
  if (!await pathAbsent(recoveryWitnessPath, fileSystem) ||
      !await pathAbsent(recoveryMovedPath, fileSystem)) return "raced";
  try {
    await fileSystem.link(fixedPath, recoveryWitnessPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "raced" : "invalid";
  }
  let recoveryWitnessSnapshot: LifetimeSourceSnapshot | undefined;
  try {
    const recoveryWitness = await readLifetimeSource(
      recoveryWitnessPath,
      fileSystem,
      MAX_CLAIM_BYTES,
    );
    recoveryWitnessSnapshot = recoveryWitness.snapshot;
    if (!sameLifetimeSource(recoveryWitness.snapshot, fixed.snapshot)) return "raced";
    const removed = await removeExactLifetimeSource(
      fixedPath,
      recoveryWitness.snapshot,
      recoveryMovedPath,
      fileSystem,
    );
    if (!removed) return "raced";
    // The durable record and witness authenticate any source moved before the
    // claimant crashed. The bounded no-fixed-claim sweep removes them together.
    return "recovered";
  } finally {
    if (recoveryWitnessSnapshot) {
      await unlinkExact(recoveryWitnessPath, recoveryWitnessSnapshot, fileSystem);
    }
  }
}

async function waitOneMillisecond(): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1));
}

/** Resolve absent, live, malformed, or proven-dead fixed claim metadata. */
export async function settleLifetimeClaim(
  directory: string,
  options: LifetimeClaimOptions = {},
  waitForLive = false,
  ignoredAuxiliaryNames: ReadonlySet<string> = new Set(),
): Promise<LifetimeClaimAvailability> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  const trusted = await validateLifetimeDirectory(directory, fileSystem);
  for (let attempt = 0; attempt < (waitForLive ? CLAIM_WAIT_ATTEMPTS : 4); attempt++) {
    const fixedState = await fixedClaimStat(
      resolve(trusted, LIFETIME_CLAIM_FILENAME),
      fileSystem,
    );
    if (fixedState === "invalid") return "invalid";
    if (fixedState === "absent") {
      const auxiliary = await recoverStrandedAuxiliaries(
        trusted,
        fileSystem,
        options,
        ignoredAuxiliaryNames,
      );
      if (auxiliary !== "busy" || !waitForLive) return auxiliary;
      await waitOneMillisecond();
      continue;
    }
    const outcome = await recoverExistingClaim(trusted, fileSystem, options);
    if (outcome === "invalid") return "invalid";
    if (outcome === "live") {
      if (!waitForLive) return "busy";
      await waitOneMillisecond();
    }
  }
  return "busy";
}

async function createClaimRecord(
  directory: string,
  source: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
  options: LifetimeClaimOptions,
): Promise<{
  readonly record: LifetimeClaimRecord;
  readonly path: string;
  readonly snapshot: LifetimeSourceSnapshot;
}> {
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const nonceBytes = randomBytes(16);
  if (nonceBytes.length !== 16) throw claimError("unsupported", "Invalid claim nonce");
  const record: LifetimeClaimRecord = {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: strictIso(options.now ?? (() => new Date())),
    nonce: nonceBytes.toString("hex"),
    source,
  };
  const path = directChildPath(
    directory,
    recordPath(directory, record.nonce),
    "Lifetime claim record",
  );
  await writeClosedFile(path, serializeClaim(record), fileSystem);
  const stored = await readLifetimeSource(path, fileSystem, MAX_CLAIM_BYTES);
  if (stored.content.toString("utf8") !== serializeClaim(record)) {
    throw claimError("unsupported", "Lifetime claim record did not persist exactly");
  }
  return { record, path, snapshot: stored.snapshot };
}

/** Acquire one fixed metadata claim, then witness the exact source by hard link. */
export async function claimLifetimeSource(
  directory: string,
  sourcePath: string,
  expected: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
  waitForClaim: boolean,
  options: LifetimeClaimOptions = {},
): Promise<LifetimeSourceClaim> {
  const trusted = await validateLifetimeDirectory(directory, fileSystem);
  const source = directChildPath(trusted, sourcePath, "Lifetime claim source");
  const own = await createClaimRecord(trusted, expected, fileSystem, options);
  const fixedPath = resolve(trusted, LIFETIME_CLAIM_FILENAME);
  const sourceWitnessPath = witnessPath(trusted, own.record.nonce);
  let fixedAcquired = false;
  try {
    for (let attempt = 0; attempt < (waitForClaim ? CLAIM_WAIT_ATTEMPTS : 4); attempt++) {
      try {
        await fileSystem.link(own.path, fixedPath);
        fixedAcquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw claimError("unsupported", "Unable to acquire lifetime metadata claim");
        }
        const availability = await settleLifetimeClaim(
          trusted,
          { ...options, fileSystem },
          waitForClaim,
          new Set([basename(own.path), basename(source)]),
        );
        if (availability === "invalid") {
          throw claimError("unsupported", "Lifetime claim metadata is ambiguous");
        }
        if (availability === "busy") throw claimError("busy", "Lifetime claim is busy");
        continue;
      }

      const fixed = await readLifetimeSource(fixedPath, fileSystem, MAX_CLAIM_BYTES);
      if (!sameLifetimeSource(fixed.snapshot, own.snapshot)) {
        throw claimError("mismatch", "Lifetime metadata claim changed");
      }
      try {
        await fileSystem.link(source, sourceWitnessPath);
      } catch {
        throw claimError("mismatch", "Unable to witness lifetime claim source");
      }
      const witness = await readLifetimeSource(sourceWitnessPath, fileSystem);
      const current = await readLifetimeSource(source, fileSystem);
      if (
        !sameLifetimeSource(expected, witness.snapshot) ||
        !sameLifetimeSource(expected, current.snapshot)
      ) {
        throw claimError("mismatch", "Lifetime source changed before claim");
      }
      return {
        directory: trusted,
        sourcePath: source,
        claimPath: fixedPath,
        recordPath: own.path,
        witnessPath: sourceWitnessPath,
        record: own.record,
        metadataSnapshot: own.snapshot,
        sourceSnapshot: expected,
      };
    }
    throw claimError("busy", "Lifetime claim remained busy");
  } catch (error) {
    const partial: LifetimeSourceClaim = {
      directory: trusted,
      sourcePath: source,
      claimPath: fixedPath,
      recordPath: own.path,
      witnessPath: sourceWitnessPath,
      record: own.record,
      metadataSnapshot: own.snapshot,
      sourceSnapshot: expected,
    };
    if (fixedAcquired) {
      await releaseLifetimeSourceClaim(partial, fileSystem).catch(() => undefined);
    } else {
      await unlinkExact(own.path, own.snapshot, fileSystem).catch(() => undefined);
    }
    throw error;
  }
}

export async function releaseLifetimeSourceClaim(
  claim: LifetimeSourceClaim,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  await unlinkExact(claim.witnessPath, claim.sourceSnapshot, fileSystem, true);
  const cleanupPath = resolve(
    claim.directory,
    `.sdl-observability-lifetime.claim-cleanup.${claim.record.nonce}`,
  );
  let fixedStillOwnsRecord = true;
  if (await pathAbsent(cleanupPath, fileSystem)) {
    fixedStillOwnsRecord = !await removeExactLifetimeSource(
      claim.claimPath,
      claim.metadataSnapshot,
      cleanupPath,
      fileSystem,
    );
  }
  if (fixedStillOwnsRecord) {
    try {
      const current = await readLifetimeSource(claim.claimPath, fileSystem, MAX_CLAIM_BYTES);
      fixedStillOwnsRecord = sameLifetimeSource(current.snapshot, claim.metadataSnapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fixedStillOwnsRecord = false;
    }
  }
  if (!fixedStillOwnsRecord) {
    await unlinkExact(claim.recordPath, claim.metadataSnapshot, fileSystem);
  }
}

/** Move a claimed path and restore any raced replacement instead of losing it. */
export async function moveClaimedLifetimeSource(
  claim: LifetimeSourceClaim,
  targetPath: string,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  await fileSystem.rename(claim.sourcePath, targetPath);
  const moved = await readLifetimeSource(targetPath, fileSystem);
  if (sameLifetimeSource(moved.snapshot, claim.sourceSnapshot)) return true;
  await restoreMovedReplacement(targetPath, claim.sourcePath, fileSystem);
  return false;
}

function parseEvidenceName(
  name: string,
  path: string,
  snapshot: LifetimeSourceSnapshot,
): EvidenceEntry {
  const match = EVIDENCE_NAME.exec(name);
  if (!match) throw new Error(`Unsupported lifetime evidence name: ${name}`);
  const eligibility = match[1];
  const timestampText = match[3];
  if (
    (eligibility !== "validated-supported" &&
      eligibility !== "protected-unknown-newer") ||
    timestampText === undefined
  ) {
    throw new Error(`Unsupported lifetime evidence name: ${name}`);
  }
  const timestamp = Number.parseInt(timestampText, 36);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`Invalid lifetime evidence timestamp: ${name}`);
  }
  return { name, path, timestamp, eligibility, snapshot };
}

async function listEvidence(
  directory: string,
  fileSystem: LifetimeFileSystem,
): Promise<EvidenceEntry[]> {
  const names = await fileSystem.readdir(directory, { encoding: "utf8" });
  const evidence: EvidenceEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(LIFETIME_EVIDENCE_PREFIX)) continue;
    const path = directChildPath(directory, resolve(directory, name), "Evidence path");
    const source = await readLifetimeSource(path, fileSystem);
    evidence.push(parseEvidenceName(name, path, source.snapshot));
  }
  return evidence;
}

function evidenceName(
  label: LifetimeEvidenceLabel,
  timestamp: number,
  nonce: Buffer,
): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("Lifetime evidence clock must return a valid timestamp");
  }
  if (nonce.length !== 16) throw new Error("Lifetime evidence nonce must contain 128 bits");
  return `${LIFETIME_EVIDENCE_PREFIX}v1.${label.eligibility}.${label.kind}.${timestamp.toString(36).padStart(11, "0")}.${nonce.toString("hex")}.json`;
}

async function unusedPath(
  directory: string,
  name: string,
  fileSystem: LifetimeFileSystem,
): Promise<string> {
  const path = directChildPath(directory, resolve(directory, name), "Lifetime target");
  if (await pathAbsent(path, fileSystem)) return path;
  const existing = await fileSystem.lstat(path, { bigint: true });
  regularFile(existing, "Lifetime target", MAX_EVIDENCE_SOURCE_BYTES);
  throw new Error("Lifetime target already exists");
}

async function removeOldestEligible(
  evidence: readonly EvidenceEntry[],
  directory: string,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  const oldest = evidence
    .filter((entry) => entry.eligibility === "validated-supported")
    .sort((left, right) => left.timestamp - right.timestamp ||
      left.name.localeCompare(right.name))[0];
  if (!oldest) throw new Error("No eligible evidence file can be removed safely");
  const current = await readLifetimeSource(oldest.path, fileSystem);
  if (!sameLifetimeSource(current.snapshot, oldest.snapshot)) {
    throw new Error("Eligible evidence changed before eviction");
  }
  const candidate = await unusedPath(
    directory,
    `${DELETE_AUXILIARY_PREFIX}${oldest.name}`,
    fileSystem,
  );
  await fileSystem.rename(oldest.path, candidate);
  const moved = await readLifetimeSource(candidate, fileSystem);
  if (!sameLifetimeSource(moved.snapshot, oldest.snapshot)) {
    await restoreMovedReplacement(candidate, oldest.path, fileSystem);
    throw new Error("Eligible evidence changed during eviction");
  }
  await fileSystem.unlink(candidate);
}

/** Atomically move one source inside the serialized shared evidence set. */
export async function rotateLifetimeEvidence(
  directory: string,
  sourcePath: string,
  label: LifetimeEvidenceLabel,
  options: LifetimeEvidenceOptions = {},
): Promise<string> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  const trusted = await validateLifetimeDirectory(directory, fileSystem);
  const source = directChildPath(trusted, sourcePath, "Evidence source");
  if (basename(source).startsWith(LIFETIME_EVIDENCE_PREFIX)) {
    throw new Error("Evidence source must not already be in the evidence namespace");
  }
  const expected = options.expectedSource ??
    (await readLifetimeSource(source, fileSystem)).snapshot;
  const claim = await claimLifetimeSource(
    trusted,
    source,
    expected,
    fileSystem,
    options.waitForClaim ?? true,
    options,
  );
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  try {
    let evidence = await listEvidence(trusted, fileSystem);
    while (evidence.length >= MAX_LIFETIME_EVIDENCE_FILES) {
      await removeOldestEligible(evidence, trusted, fileSystem);
      evidence = await listEvidence(trusted, fileSystem);
    }
    const timestamp = (options.now ?? (() => new Date()))().getTime();
    const target = await unusedPath(
      trusted,
      evidenceName(label, timestamp, randomBytes(16)),
      fileSystem,
    );
    if (!await moveClaimedLifetimeSource(claim, target, fileSystem)) {
      throw claimError("mismatch", "Evidence source changed during rotation");
    }
    return target;
  } finally {
    await releaseLifetimeSourceClaim(claim, fileSystem);
  }
}
