import { randomBytes as nodeRandomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

export const MAX_LIFETIME_EVIDENCE_FILES = 8;
export const LIFETIME_EVIDENCE_PREFIX = "sdl-observability-lifetime.evidence.";

export interface LifetimeEvidenceLabel {
  readonly kind: "lock" | "publication";
  readonly eligibility: "validated-supported" | "protected-unknown-newer";
}

export interface LifetimeFileSystem {
  readonly open: typeof nodeFs.open;
  readonly lstat: typeof nodeFs.lstat;
  readonly readFile: typeof nodeFs.readFile;
  readonly readdir: typeof nodeFs.readdir;
  readonly rename: typeof nodeFs.rename;
  readonly unlink: typeof nodeFs.unlink;
}

export type LifetimeFileSystemOverrides = Partial<LifetimeFileSystem>;

export interface LifetimeEvidenceOptions {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly fileSystem?: LifetimeFileSystemOverrides;
}

interface EvidenceEntry {
  readonly name: string;
  readonly path: string;
  readonly timestamp: number;
  readonly eligibility: LifetimeEvidenceLabel["eligibility"];
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
    rename: overrides.rename ?? nodeFs.rename,
    unlink: overrides.unlink ?? nodeFs.unlink,
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function assertTrustedDirectory(
  directory: string,
  fileSystem: LifetimeFileSystem,
): Promise<string> {
  const trustedDirectory = resolve(directory);
  const stat = await fileSystem.lstat(trustedDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Lifetime evidence directory must be a regular non-symlink directory");
  }
  return trustedDirectory;
}

function directChildPath(directory: string, path: string, label: string): string {
  const candidate = resolve(path);
  if (!samePath(dirname(candidate), directory)) {
    throw new Error(`${label} must remain directly inside the trusted directory`);
  }
  return candidate;
}

function assertRegularNonSymlink(stat: Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink evidence file`);
  }
}

function parseEvidenceName(name: string, path: string): EvidenceEntry {
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
  return { name, path, timestamp, eligibility };
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
    const stat = await fileSystem.lstat(path);
    assertRegularNonSymlink(stat, "Lifetime evidence");
    evidence.push(parseEvidenceName(name, path));
  }
  return evidence;
}

async function removeOldestEligible(
  evidence: readonly EvidenceEntry[],
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  const oldest = evidence
    .filter((entry) => entry.eligibility === "validated-supported")
    .sort((left, right) => left.timestamp - right.timestamp ||
      left.name.localeCompare(right.name))[0];
  if (!oldest) {
    throw new Error("No eligible evidence file can be removed safely");
  }
  const stat = await fileSystem.lstat(oldest.path);
  assertRegularNonSymlink(stat, "Lifetime evidence");
  await fileSystem.unlink(oldest.path);
}

function evidenceName(
  label: LifetimeEvidenceLabel,
  timestamp: number,
  nonce: Buffer,
): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("Lifetime evidence clock must return a valid timestamp");
  }
  if (nonce.length !== 16) {
    throw new Error("Lifetime evidence nonce must contain 128 bits");
  }
  const encodedTimestamp = timestamp.toString(36).padStart(11, "0");
  return `${LIFETIME_EVIDENCE_PREFIX}v1.${label.eligibility}.${label.kind}.${encodedTimestamp}.${nonce.toString("hex")}.json`;
}

async function unusedEvidencePath(
  directory: string,
  label: LifetimeEvidenceLabel,
  options: LifetimeEvidenceOptions,
  fileSystem: LifetimeFileSystem,
): Promise<string> {
  const timestamp = (options.now ?? (() => new Date()))().getTime();
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  for (let attempt = 0; attempt < 4; attempt++) {
    const path = directChildPath(
      directory,
      resolve(directory, evidenceName(label, timestamp, randomBytes(16))),
      "Evidence target",
    );
    try {
      const stat = await fileSystem.lstat(path);
      assertRegularNonSymlink(stat, "Lifetime evidence target");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
      throw error;
    }
  }
  throw new Error("Unable to allocate a collision-free lifetime evidence name");
}

/**
 * Atomically moves one validated source into the shared bounded evidence set.
 * Future publication recovery marks unknown-newer data as protected through
 * the label so older code never rotates or deletes it.
 */
export async function rotateLifetimeEvidence(
  directory: string,
  sourcePath: string,
  label: LifetimeEvidenceLabel,
  options: LifetimeEvidenceOptions = {},
): Promise<string> {
  const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
  const trustedDirectory = await assertTrustedDirectory(directory, fileSystem);
  const source = directChildPath(trustedDirectory, sourcePath, "Evidence source");
  if (basename(source).startsWith(LIFETIME_EVIDENCE_PREFIX)) {
    throw new Error("Evidence source must not already be in the evidence namespace");
  }
  assertRegularNonSymlink(await fileSystem.lstat(source), "Evidence source");

  let evidence = await listEvidence(trustedDirectory, fileSystem);
  while (evidence.length >= MAX_LIFETIME_EVIDENCE_FILES) {
    await removeOldestEligible(evidence, fileSystem);
    evidence = await listEvidence(trustedDirectory, fileSystem);
  }

  const target = await unusedEvidencePath(
    trustedDirectory,
    label,
    options,
    fileSystem,
  );
  assertRegularNonSymlink(await fileSystem.lstat(source), "Evidence source");
  await fileSystem.rename(source, target);
  assertRegularNonSymlink(await fileSystem.lstat(target), "Lifetime evidence target");
  return target;
}
