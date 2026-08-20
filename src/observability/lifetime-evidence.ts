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
const CLAIM_WAIT_ATTEMPTS = 1_000;

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

export interface LifetimeSourceClaim {
  readonly directory: string;
  readonly sourcePath: string;
  readonly claimPath: string;
  readonly snapshot: LifetimeSourceSnapshot;
}

export interface LifetimeEvidenceOptions {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly fileSystem?: LifetimeFileSystemOverrides;
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

async function trustedDirectory(
  directory: string,
  fileSystem: LifetimeFileSystem,
): Promise<string> {
  const trusted = resolve(directory);
  const stat = await fileSystem.lstat(trusted);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Lifetime evidence directory must be a regular non-symlink directory");
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

function regularFile(stat: Stats, label: string, maxBytes: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink evidence file`);
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

function claimError(code: "busy" | "mismatch" | "unsupported", message: string): Error {
  return Object.assign(new Error(message), { lifetimeClaimCode: code });
}

export function lifetimeClaimErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "lifetimeClaimCode" in error
    ? String((error as { lifetimeClaimCode: unknown }).lifetimeClaimCode)
    : undefined;
}

async function waitOneMillisecond(): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1));
}

async function unlinkExactClaim(
  claim: LifetimeSourceClaim,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  try {
    const current = await readLifetimeSource(claim.claimPath, fileSystem);
    if (sameLifetimeIdentity(current.snapshot, claim.snapshot)) {
      await fileSystem.unlink(claim.claimPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Claim the exact inspected source through one fixed cross-process hard link. */
export async function claimLifetimeSource(
  directory: string,
  sourcePath: string,
  expected: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
  waitForClaim: boolean,
): Promise<LifetimeSourceClaim> {
  const claimPath = directChildPath(
    directory,
    resolve(directory, LIFETIME_CLAIM_FILENAME),
    "Lifetime claim",
  );
  for (let attempt = 0; attempt < (waitForClaim ? CLAIM_WAIT_ATTEMPTS : 1); attempt++) {
    try {
      await fileSystem.link(sourcePath, claimPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw claimError("unsupported", "Unable to acquire lifetime hard-link claim");
      }
      const existing = await fileSystem.lstat(claimPath);
      regularFile(existing, "Lifetime claim", MAX_EVIDENCE_SOURCE_BYTES);
      if (!waitForClaim) throw claimError("busy", "Lifetime claim is busy");
      await waitOneMillisecond();
      continue;
    }

    let claim: LifetimeSourceClaim | undefined;
    try {
      const claimed = await readLifetimeSource(claimPath, fileSystem);
      claim = { directory, sourcePath, claimPath, snapshot: claimed.snapshot };
      const current = await readLifetimeSource(sourcePath, fileSystem);
      if (
        !sameLifetimeSource(expected, claimed.snapshot) ||
        !sameLifetimeSource(expected, current.snapshot)
      ) {
        throw claimError("mismatch", "Lifetime source changed before claim");
      }
      return claim;
    } catch (error) {
      if (claim) await unlinkExactClaim(claim, fileSystem);
      throw error;
    }
  }
  throw claimError("busy", "Lifetime claim remained busy");
}

export async function releaseLifetimeSourceClaim(
  claim: LifetimeSourceClaim,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  await unlinkExactClaim(claim, fileSystem);
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

/** Move a claimed path and restore any raced replacement instead of losing it. */
export async function moveClaimedLifetimeSource(
  claim: LifetimeSourceClaim,
  targetPath: string,
  fileSystem: LifetimeFileSystem,
): Promise<boolean> {
  await fileSystem.rename(claim.sourcePath, targetPath);
  const moved = await readLifetimeSource(targetPath, fileSystem);
  if (sameLifetimeSource(moved.snapshot, claim.snapshot)) return true;
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
  try {
    const existing = await fileSystem.lstat(path);
    regularFile(existing, "Lifetime target", MAX_EVIDENCE_SOURCE_BYTES);
    throw new Error("Lifetime target already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
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
  const trusted = await trustedDirectory(directory, fileSystem);
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
