import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as nodeFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

export const MAX_LIFETIME_EVIDENCE_FILES = 8;
export const LIFETIME_EVIDENCE_PREFIX = "sdl-observability-lifetime.evidence.";
export const LIFETIME_CLAIM_FILENAME = "sdl-observability-lifetime.claim";
const MAX_EVIDENCE_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CLAIM_BYTES = 16 * 1024;
const CLAIM_WAIT_ATTEMPTS = 1_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX_128 = /^[0-9a-f]{32}$/;
const SHA_256 = /^[0-9a-f]{64}$/;

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

type ExistingClaimOutcome = "recovered" | "raced" | "live" | "invalid";
export type LifetimeClaimAvailability = "available" | "busy" | "invalid";

const EVIDENCE_NAME = /^sdl-observability-lifetime\.evidence\.v1\.(validated-supported|protected-unknown-newer)\.(lock|publication)\.([0-9a-z]{11})\.([0-9a-f]{32})\.json$/;

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
  const stat = await fileSystem.lstat(trusted);
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

function regularFile(stat: Stats, label: string, maxBytes: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (stat.size > maxBytes) throw new Error(`${label} exceeds its size limit`);
}

function statSnapshot(stat: Stats, content: Buffer): LifetimeSourceSnapshot {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size,
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

function sameLifetimeIdentity(
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
  const before = await fileSystem.lstat(path);
  regularFile(before, "Lifetime source", maxBytes);
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    regularFile(opened, "Lifetime source", maxBytes);
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) {
      throw new Error("Lifetime source changed while opening");
    }
    const content = await handle.readFile();
    const afterOpen = await handle.stat();
    const afterPath = await fileSystem.lstat(path);
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
    typeof source.ino !== "string" ||
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
    await fileSystem.lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
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

async function removeFixedClaim(
  claimPath: string,
  expected: LifetimeSourceSnapshot,
  candidatePath: string,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  try {
    await fileSystem.rename(claimPath, candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = await readLifetimeSource(candidatePath, fileSystem, MAX_CLAIM_BYTES);
  if (!sameLifetimeSource(moved.snapshot, expected)) {
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

async function recoverExistingClaim(
  directory: string,
  fileSystem: LifetimeFileSystem,
  options: LifetimeClaimOptions,
): Promise<ExistingClaimOutcome> {
  const fixedPath = resolve(directory, LIFETIME_CLAIM_FILENAME);
  let fixed: Awaited<ReturnType<typeof readLifetimeSource>>;
  try {
    fixed = await readLifetimeSource(fixedPath, fileSystem, MAX_CLAIM_BYTES);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "raced" : "invalid";
  }
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
    return "invalid";
  }
  if (!sameLifetimeSource(fixed.snapshot, durableRecord.snapshot)) return "invalid";

  const durableWitnessPath = directChildPath(
    directory,
    witnessPath(directory, record.nonce),
    "Lifetime claim source witness",
  );
  let witness: Awaited<ReturnType<typeof readLifetimeSource>> | null = null;
  try {
    witness = await readLifetimeSource(durableWitnessPath, fileSystem);
    if (!sameLifetimeIdentity(witness.snapshot, record.source)) return "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "invalid";
  }
  if (await claimantAlive(record.pid, options)) return "live";

  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const recoveryNonce = randomBytes(16);
  if (recoveryNonce.length !== 16) return "invalid";
  const recoveryWitnessPath = resolve(
    directory,
    `.sdl-observability-lifetime.claim-recovery-witness.${recoveryNonce.toString("hex")}`,
  );
  const recoveryMovedPath = resolve(
    directory,
    `.sdl-observability-lifetime.claim-recovery-moved.${recoveryNonce.toString("hex")}`,
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
    const removed = await removeFixedClaim(
      fixedPath,
      recoveryWitness.snapshot,
      recoveryMovedPath,
      fileSystem,
    );
    if (!removed) return "raced";
    if (witness) await unlinkExact(durableWitnessPath, witness.snapshot, fileSystem, true);
    await unlinkExact(durableRecordPath, durableRecord.snapshot, fileSystem);
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
): Promise<LifetimeClaimAvailability> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  const trusted = await validateLifetimeDirectory(directory, fileSystem);
  for (let attempt = 0; attempt < (waitForLive ? CLAIM_WAIT_ATTEMPTS : 4); attempt++) {
    if (await pathAbsent(resolve(trusted, LIFETIME_CLAIM_FILENAME), fileSystem)) {
      return "available";
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
    fixedStillOwnsRecord = !await removeFixedClaim(
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
  const existing = await fileSystem.lstat(path);
  regularFile(existing, "Lifetime target", MAX_EVIDENCE_SOURCE_BYTES);
  throw new Error("Lifetime target already exists");
}

async function removeOldestEligible(
  evidence: readonly EvidenceEntry[],
  directory: string,
  randomBytes: (size: number) => Buffer,
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
    `.sdl-observability-lifetime.delete.${randomBytes(16).toString("hex")}`,
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
      await removeOldestEligible(evidence, trusted, randomBytes, fileSystem);
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
