import { randomBytes as nodeRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  claimLifetimeSource,
  moveClaimedLifetimeSource,
  readLifetimeSource,
  releaseLifetimeSourceClaim,
  removeExactLifetimeSource,
  revalidateLifetimeDirectory,
  resolveLifetimeFileSystem,
  rotateLifetimeEvidence,
  sameLifetimeSource,
  settleLifetimeClaim,
  validateLifetimeDirectoryBinding,
  type LifetimeFileSystem,
  type LifetimeFileSystemOverrides,
  type LifetimeSourceSnapshot,
} from "./lifetime-evidence.js";
import {
  LIFETIME_SCHEMA_VERSION,
  MAX_STORE_BYTES,
  parseDurableLifetimeRoot,
  type DurableLifetimeRoot,
  type RecoveryReason,
} from "./lifetime-types.js";

const PRIMARY_FILENAME = "sdl-observability-lifetime.json";
const BACKUP_FILENAME = "sdl-observability-lifetime.backup.json";
const TEMP_PREFIX = "sdl-observability-lifetime.temp.";
const TEMP_NAME = /^sdl-observability-lifetime\.temp\.[0-9a-f]{32}\.json$/;
const MAX_RECOVERY_CANDIDATES = 4;
const MAX_TEMP_CREATE_ATTEMPTS = 4;

type FaultStage =
  | "beforeTempCreate"
  | "tempWrite"
  | "tempSync"
  | "tempClose"
  | "tempReopen"
  | "tempValidation"
  | "afterTempValidation"
  | "backupDisposition"
  | "afterPrimaryToBackup"
  | "tempToPrimary"
  | "afterTempToPrimary"
  | "directoryFlush"
  | "finalPrimaryReopen"
  | "finalPrimaryRead"
  | "finalPrimaryValidation";

/** Narrow injection seam for deterministic filesystem and crash-boundary tests. */
export interface LifetimePublicationOptions {
  readonly fileSystem?: LifetimeFileSystemOverrides;
  readonly randomBytes?: (size: number) => Buffer;
  readonly now?: () => Date;
  readonly fault?: (stage: FaultStage) => void | Promise<void>;
}

export interface LifetimeReadOnlyLoadOptions {
  readonly fileSystem?: LifetimeFileSystemOverrides;
}

export type ReadOnlyLoadOutcome =
  | { readonly status: "ready"; readonly root: DurableLifetimeRoot; readonly generation: number }
  | { readonly status: "empty" }
  | { readonly status: "ioFailure" }
  | {
      readonly status: "recoveryRequired";
      readonly reason: Extract<RecoveryReason, "unknownSchema" | "corruptCandidates">;
    };

type PublicationOutcome =
  | { readonly status: "committed"; readonly root: DurableLifetimeRoot; readonly generation: number }
  | {
      readonly status: "notPublished";
      readonly reason: "staleGeneration" | "generationConflict" | "invalidGeneration" | "ioFailure";
    }
  | {
      readonly status: "indeterminate";
      readonly reason:
        | "publicationCommitUncertain"
        | "tempNeutralizationUncertain"
        | "authorityUncertain";
      readonly stage: "commit" | "primaryDisposition" | "primaryRestore" | "tempCleanup";
    };

type RecoveryOutcome =
  | { readonly status: "ready"; readonly root: DurableLifetimeRoot; readonly generation: number }
  | { readonly status: "empty" }
  | { readonly status: "ioFailure" }
  | {
      readonly status: "recoveryRequired";
      readonly reason: Extract<
        RecoveryReason,
        "unknownSchema" | "corruptCandidates" | "indeterminatePublication"
      >;
    };

type CandidateState =
  | { readonly status: "missing"; readonly path: string; readonly rank: number }
  | {
      readonly status: "valid";
      readonly path: string;
      readonly rank: number;
      readonly root: DurableLifetimeRoot;
      readonly content: Buffer;
      readonly source: LifetimeSourceSnapshot;
    }
  | { readonly status: "ioFailure"; readonly path: string; readonly rank: number }
  | {
      readonly status: "corrupt" | "unknownNewer";
      readonly path: string;
      readonly rank: number;
      readonly source?: LifetimeSourceSnapshot;
    };

type ExactMoveOutcome = {
  readonly state: "moved" | "notMoved" | "indeterminate";
  readonly error?: unknown;
};

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function inject(options: LifetimePublicationOptions, stage: FaultStage): Promise<void> {
  await options.fault?.(stage);
}

function serializeRoot(root: DurableLifetimeRoot): {
  readonly root: DurableLifetimeRoot;
  readonly content: Buffer;
} {
  const parsed = parseDurableLifetimeRoot(root);
  const content = Buffer.from(JSON.stringify(parsed), "utf8");
  if (content.length > MAX_STORE_BYTES) {
    throw new Error("Lifetime store exceeds its size limit");
  }
  return { root: parsed, content };
}

function parsedSchemaVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  return typeof schemaVersion === "number" ? schemaVersion : undefined;
}

function parseCandidateContent(
  path: string,
  rank: number,
  content: Buffer,
  source: LifetimeSourceSnapshot,
): CandidateState {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    return { status: "corrupt", path, rank, source };
  }
  const schemaVersion = parsedSchemaVersion(value);
  if (schemaVersion !== undefined && schemaVersion > LIFETIME_SCHEMA_VERSION) {
    return { status: "unknownNewer", path, rank, source };
  }
  try {
    return {
      status: "valid",
      path,
      rank,
      root: parseDurableLifetimeRoot(value),
      content,
      source,
    };
  } catch {
    return { status: "corrupt", path, rank, source };
  }
}

async function readCandidate(
  path: string,
  rank: number,
  fileSystem: LifetimeFileSystem,
): Promise<CandidateState> {
  try {
    const source = await readLifetimeSource(path, fileSystem, MAX_STORE_BYTES);
    return parseCandidateContent(path, rank, source.content, source.snapshot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing", path, rank };
    if (errorCode(error) !== undefined) return { status: "ioFailure", path, rank };
    return { status: "corrupt", path, rank };
  }
}

async function pathMissing(path: string, fileSystem: LifetimeFileSystem): Promise<boolean> {
  try {
    await fileSystem.lstat(path, { bigint: true });
    return false;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function nonce(options: LifetimePublicationOptions): string {
  const bytes = (options.randomBytes ?? nodeRandomBytes)(16);
  if (bytes.length !== 16) throw new Error("Lifetime publication nonce must contain 128 bits");
  return bytes.toString("hex");
}

async function createTemp(
  directory: string,
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
): Promise<{ readonly path: string; readonly handle: FileHandle }> {
  for (let attempt = 0; attempt < MAX_TEMP_CREATE_ATTEMPTS; attempt++) {
    const path = resolve(directory, `${TEMP_PREFIX}${nonce(options)}.json`);
    try {
      return { path, handle: await fileSystem.open(path, "wx", 0o600) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate a unique lifetime publication temp");
}

function evidenceOptions(options: LifetimePublicationOptions, fileSystem: LifetimeFileSystem) {
  return {
    fileSystem,
    randomBytes: options.randomBytes,
    now: options.now,
  };
}

async function rotateCandidate(
  directory: string,
  candidate: {
    readonly path: string;
    readonly source?: LifetimeSourceSnapshot;
  },
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
): Promise<void> {
  if (!candidate.source) throw new Error("Lifetime candidate cannot be moved safely");
  await rotateLifetimeEvidence(
    directory,
    candidate.path,
    { kind: "publication", eligibility: "validated-supported" },
    { ...evidenceOptions(options, fileSystem), expectedSource: candidate.source },
  );
}

async function disposeBackup(
  directory: string,
  backupPath: string,
  candidate: { readonly root: DurableLifetimeRoot; readonly content: Buffer },
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
): Promise<"cleared" | "protected"> {
  const backup = await readCandidate(backupPath, 1, fileSystem);
  if (backup.status === "missing") return "cleared";
  if (backup.status === "ioFailure") throw new Error("Lifetime backup could not be read");
  if (backup.status === "unknownNewer") {
    throw new Error("Unknown newer lifetime backup must remain untouched");
  }
  if (backup.status === "valid") {
    if (backup.root.generation > candidate.root.generation) {
      throw new Error("Lifetime backup is newer than the candidate");
    }
    if (backup.root.generation === candidate.root.generation) {
      if (!backup.content.equals(candidate.content)) {
        throw new Error("Lifetime backup conflicts with the candidate generation");
      }
      return "protected";
    }
  }
  await rotateCandidate(directory, backup, fileSystem, options);
  return "cleared";
}

async function moveExactSource(
  directory: string,
  sourcePath: string,
  targetPath: string,
  source: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
  onMoved?: () => void,
): Promise<ExactMoveOutcome> {
  if (!await pathMissing(targetPath, fileSystem)) return { state: "notMoved" };
  let claim: Awaited<ReturnType<typeof claimLifetimeSource>>;
  try {
    claim = await claimLifetimeSource(
      directory,
      sourcePath,
      source,
      fileSystem,
      true,
      evidenceOptions(options, fileSystem),
    );
  } catch (error) {
    return { state: "notMoved", error };
  }

  let state: ExactMoveOutcome["state"] = "notMoved";
  let moveError: unknown;
  try {
    if (await pathMissing(targetPath, fileSystem) &&
        await moveClaimedLifetimeSource(claim, targetPath, fileSystem)) {
      state = "moved";
      onMoved?.();
    }
  } catch (error) {
    moveError = error;
    try {
      const target = await readLifetimeSource(targetPath, fileSystem, MAX_STORE_BYTES);
      if (sameLifetimeSource(target.snapshot, source) && await pathMissing(sourcePath, fileSystem)) {
        state = "moved";
        onMoved?.();
      } else {
        state = "indeterminate";
      }
    } catch {
      state = "indeterminate";
    }
  }

  let cleanupError: unknown;
  try {
    await releaseLifetimeSourceClaim(claim, fileSystem);
  } catch (error) {
    cleanupError = error;
    // A one-shot cleanup failure must not leave our own live claim blocking the
    // compensating move. Retry the exact claim, then drain Task 3A auxiliaries.
    await releaseLifetimeSourceClaim(claim, fileSystem).catch(() => undefined);
    await settleLifetimeClaim(
      directory,
      evidenceOptions(options, fileSystem),
      false,
    ).catch(() => undefined);
  }
  return { state, error: moveError ?? cleanupError };
}

async function removeTemp(
  directory: string,
  tempPath: string | undefined,
  expected: LifetimeSourceSnapshot | undefined,
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
): Promise<boolean> {
  if (!tempPath) return true;
  let snapshot = expected;
  if (!snapshot) {
    try {
      snapshot = (await readLifetimeSource(tempPath, fileSystem, MAX_STORE_BYTES)).snapshot;
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
  }
  const cleanup = resolve(directory, `.sdl-observability-lifetime.aux-delete.${nonce(options)}`);
  if (!await pathMissing(cleanup, fileSystem)) return false;
  try {
    await removeExactLifetimeSource(
      tempPath,
      snapshot,
      cleanup,
      fileSystem,
      false,
      MAX_STORE_BYTES,
    );
  } catch {
    // A failed final unlink is still neutralized if the validated candidate has
    // already left the startup temp namespace.
  }
  try {
    return await pathMissing(tempPath, fileSystem);
  } catch {
    return false;
  }
}

async function restorePrimary(
  directory: string,
  primaryPath: string,
  backupPath: string,
  expected: LifetimeSourceSnapshot,
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
): Promise<boolean> {
  try {
    const current = await readLifetimeSource(primaryPath, fileSystem, MAX_STORE_BYTES);
    if (sameLifetimeSource(current.snapshot, expected)) return true;
    return false;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return false;
  }
  const restored = await moveExactSource(
    directory,
    backupPath,
    primaryPath,
    expected,
    fileSystem,
    options,
  );
  if (restored.state !== "moved") return false;
  try {
    const current = await readLifetimeSource(primaryPath, fileSystem, MAX_STORE_BYTES);
    return sameLifetimeSource(current.snapshot, expected);
  } catch {
    return false;
  }
}

async function flushDirectory(
  directory: string,
  fileSystem: LifetimeFileSystem,
): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fileSystem.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read only the canonical primary without applying recovery or adoption policy. */
export async function loadLifetimeGenerationReadOnly(
  directory: string,
  options: LifetimeReadOnlyLoadOptions = {},
): Promise<ReadOnlyLoadOutcome> {
  try {
    const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
    const binding = await validateLifetimeDirectoryBinding(directory, fileSystem);
    const primary = await readCandidate(resolve(binding.directory, PRIMARY_FILENAME), 0, fileSystem);
    if (primary.status === "missing") return { status: "empty" };
    if (primary.status === "ioFailure") return { status: "ioFailure" };
    if (primary.status === "unknownNewer") {
      return { status: "recoveryRequired", reason: "unknownSchema" };
    }
    if (primary.status !== "valid") {
      return { status: "recoveryRequired", reason: "corruptCandidates" };
    }
    return {
      status: "ready",
      root: primary.root,
      generation: primary.root.generation,
    };
  } catch (error) {
    return errorCode(error) === undefined
      ? { status: "recoveryRequired", reason: "corruptCandidates" }
      : { status: "ioFailure" };
  }
}

/** Publish one immutable generation; temp-to-primary rename is the commit boundary. */
export async function publishLifetimeGeneration(
  directory: string,
  root: DurableLifetimeRoot,
  currentCommittedGeneration: number,
  options: LifetimePublicationOptions = {},
): Promise<PublicationOutcome> {
  let fileSystem: LifetimeFileSystem;
  let trusted = "";
  let primaryPath = "";
  let backupPath = "";
  let handle: FileHandle | undefined;
  let tempPath: string | undefined;
  let tempSnapshot: LifetimeSourceSnapshot | undefined;
  let previousPrimary: LifetimeSourceSnapshot | undefined;
  let primaryMoved = false;
  let primaryMoveUncertain = false;
  let protectedBackup = false;
  let protectedWinnerDisposition = false;
  let commitAttempted = false;

  if (!Number.isSafeInteger(currentCommittedGeneration) || currentCommittedGeneration < 0) {
    return { status: "notPublished", reason: "invalidGeneration" };
  }

  let serialized: ReturnType<typeof serializeRoot>;
  try {
    serialized = serializeRoot(root);
  } catch {
    return { status: "notPublished", reason: "invalidGeneration" };
  }
  if (serialized.root.generation < currentCommittedGeneration) {
    return { status: "notPublished", reason: "staleGeneration" };
  }

  try {
    fileSystem = resolveLifetimeFileSystem(options.fileSystem);
    const binding = await validateLifetimeDirectoryBinding(directory, fileSystem);
    trusted = binding.directory;
    primaryPath = resolve(trusted, PRIMARY_FILENAME);
    backupPath = resolve(trusted, BACKUP_FILENAME);

    const primary = await readCandidate(primaryPath, 0, fileSystem);
    const backup = await readCandidate(backupPath, 1, fileSystem);
    if (primary.status === "ioFailure" || backup.status === "ioFailure") {
      return { status: "notPublished", reason: "ioFailure" };
    }
    if (primary.status === "unknownNewer" || primary.status === "corrupt") {
      return { status: "notPublished", reason: "ioFailure" };
    }
    if (backup.status === "unknownNewer") {
      return { status: "notPublished", reason: "ioFailure" };
    }
    if (backup.status === "valid") {
      if (serialized.root.generation < backup.root.generation) {
        return { status: "notPublished", reason: "staleGeneration" };
      }
      if (serialized.root.generation === backup.root.generation) {
        if (!backup.content.equals(serialized.content)) {
          return { status: "notPublished", reason: "generationConflict" };
        }
        protectedBackup = true;
      }
    }
    if (primary.status === "valid") {
      if (serialized.root.generation < primary.root.generation) {
        return { status: "notPublished", reason: "staleGeneration" };
      }
      if (serialized.root.generation === primary.root.generation) {
        return primary.content.equals(serialized.content)
          ? {
              status: "committed",
              root: primary.root,
              generation: primary.root.generation,
            }
          : { status: "notPublished", reason: "generationConflict" };
      }
      previousPrimary = primary.source;
    }
    await inject(options, "beforeTempCreate");
    const temp = await createTemp(trusted, fileSystem, options);
    tempPath = temp.path;
    handle = temp.handle;
    await inject(options, "tempWrite");
    await handle.writeFile(serialized.content);
    await inject(options, "tempSync");
    await handle.sync();
    await inject(options, "tempClose");
    await handle.close();
    handle = undefined;

    await inject(options, "tempReopen");
    const storedTemp = await readLifetimeSource(tempPath, fileSystem, MAX_STORE_BYTES);
    await inject(options, "tempValidation");
    const parsedTemp = parseCandidateContent(tempPath, 2, storedTemp.content, storedTemp.snapshot);
    if (
      parsedTemp.status !== "valid" ||
      parsedTemp.root.generation !== serialized.root.generation ||
      !storedTemp.content.equals(serialized.content)
    ) {
      throw new Error("Lifetime temp validation failed");
    }
    tempSnapshot = storedTemp.snapshot;
    await inject(options, "afterTempValidation");

    await inject(options, "backupDisposition");
    protectedBackup = await disposeBackup(
      trusted,
      backupPath,
      serialized,
      fileSystem,
      options,
    ) === "protected";

    if (previousPrimary) {
      if (protectedBackup) {
        protectedWinnerDisposition = true;
        try {
          await rotateLifetimeEvidence(
            trusted,
            primaryPath,
            { kind: "publication", eligibility: "validated-supported" },
            {
              ...evidenceOptions(options, fileSystem),
              expectedSource: previousPrimary,
            },
          );
        } catch (error) {
          await settleLifetimeClaim(trusted, {
            ...evidenceOptions(options, fileSystem),
            isClaimantPidAlive: (pid) => pid !== process.pid,
          }).catch(() => undefined);
          throw error;
        }
      } else {
        const moved = await moveExactSource(
          trusted,
          primaryPath,
          backupPath,
          previousPrimary,
          fileSystem,
          options,
          () => { primaryMoved = true; },
        );
        primaryMoveUncertain = moved.state === "indeterminate";
        if (moved.state !== "moved" || moved.error) {
          throw new Error("Lifetime primary move did not complete cleanly");
        }
      }
      await inject(options, "afterPrimaryToBackup");
    }

    await inject(options, "tempToPrimary");
    if (!await pathMissing(primaryPath, fileSystem)) {
      throw new Error("Lifetime primary was replaced before commit");
    }
    const currentTemp = await readLifetimeSource(tempPath, fileSystem, MAX_STORE_BYTES);
    if (!sameLifetimeSource(currentTemp.snapshot, tempSnapshot) ||
        !currentTemp.content.equals(serialized.content)) {
      throw new Error("Lifetime temp changed before commit");
    }
    await revalidateLifetimeDirectory(binding, fileSystem);
    commitAttempted = true;
    await fileSystem.rename(tempPath, primaryPath);
    tempPath = undefined;
    await inject(options, "afterTempToPrimary");

    await inject(options, "directoryFlush");
    await flushDirectory(trusted, fileSystem);
    await inject(options, "finalPrimaryReopen");
    const finalPrimary = await readLifetimeSource(primaryPath, fileSystem, MAX_STORE_BYTES);
    await inject(options, "finalPrimaryRead");
    const parsedFinal = parseCandidateContent(
      primaryPath,
      0,
      finalPrimary.content,
      finalPrimary.snapshot,
    );
    await inject(options, "finalPrimaryValidation");
    if (
      parsedFinal.status !== "valid" ||
      parsedFinal.root.generation !== serialized.root.generation ||
      !finalPrimary.content.equals(serialized.content)
    ) {
      throw new Error("Final lifetime primary validation failed");
    }
    if (protectedBackup) {
      const duplicateBackup = await readCandidate(backupPath, 1, fileSystem);
      if (duplicateBackup.status === "ioFailure" || duplicateBackup.status === "unknownNewer") {
        throw new Error("Protected lifetime backup changed before post-commit cleanup");
      }
      if (duplicateBackup.status !== "missing") {
        await rotateCandidate(trusted, duplicateBackup, fileSystem, options);
      }
    }
    return {
      status: "committed",
      root: parsedFinal.root,
      generation: parsedFinal.root.generation,
    };
  } catch {
    await handle?.close().catch(() => undefined);
    if (commitAttempted) {
      return {
        status: "indeterminate",
        reason: "publicationCommitUncertain",
        stage: "commit",
      };
    }
    let authorityRestored = true;
    if (trusted && (primaryMoved || primaryMoveUncertain) && previousPrimary) {
      authorityRestored = await restorePrimary(
        trusted,
        primaryPath,
        backupPath,
        previousPrimary,
        fileSystem!,
        options,
      ).catch(() => false);
    }
    let tempNeutralized = true;
    if (trusted) {
      tempNeutralized = await removeTemp(
        trusted,
        tempPath,
        tempSnapshot,
        fileSystem!,
        options,
      ).catch(() => false);
    }
    if (tempPath && !tempNeutralized) {
      return {
        status: "indeterminate",
        reason: "tempNeutralizationUncertain",
        stage: "tempCleanup",
      };
    }
    if (protectedWinnerDisposition) {
      return {
        status: "indeterminate",
        reason: "publicationCommitUncertain",
        stage: "primaryDisposition",
      };
    }
    if (!authorityRestored) {
      return {
        status: "indeterminate",
        reason: "authorityUncertain",
        stage: "primaryRestore",
      };
    }
    return { status: "notPublished", reason: "ioFailure" };
  }
}

async function recoveryNames(directory: string, fileSystem: LifetimeFileSystem): Promise<string[] | null> {
  const opened = await fileSystem.opendir(directory, { encoding: "utf8" });
  const names: string[] = [];
  for await (const entry of opened) {
    const name = String(entry.name);
    if (name !== PRIMARY_FILENAME && name !== BACKUP_FILENAME && !TEMP_NAME.test(name)) {
      continue;
    }
    names.push(name);
    if (names.length > MAX_RECOVERY_CANDIDATES) return null;
  }
  return names.sort((left, right) => {
    const rank = (name: string) => name === PRIMARY_FILENAME ? 0 : name === BACKUP_FILENAME ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right);
  });
}

async function quarantineIfPresent(
  directory: string,
  candidate: CandidateState,
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
): Promise<void> {
  if (candidate.status === "missing" || candidate.status === "unknownNewer" ||
      candidate.status === "ioFailure") return;
  await rotateCandidate(directory, candidate, fileSystem, options);
}

function recoveryError(error: unknown): RecoveryOutcome {
  return errorCode(error) === undefined
    ? { status: "recoveryRequired", reason: "corruptCandidates" }
    : { status: "ioFailure" };
}

async function cleanupRecoveryCandidates(
  directory: string,
  candidatePaths: readonly string[],
  winningGeneration: number,
  fileSystem: LifetimeFileSystem,
  options: LifetimePublicationOptions,
): Promise<RecoveryOutcome | undefined> {
  const primaryPath = resolve(directory, PRIMARY_FILENAME);
  const backupPath = resolve(directory, BACKUP_FILENAME);
  const paths = new Set([...candidatePaths, backupPath]);
  for (const path of paths) {
    if (path === primaryPath) continue;
    const candidate = await readCandidate(path, path === backupPath ? 1 : 2, fileSystem);
    if (candidate.status === "missing") continue;
    if (candidate.status === "ioFailure") return { status: "ioFailure" };
    if (candidate.status === "unknownNewer") {
      return { status: "recoveryRequired", reason: "unknownSchema" };
    }
    if (candidate.status === "valid" && candidate.root.generation > winningGeneration) {
      return { status: "recoveryRequired", reason: "indeterminatePublication" };
    }
    await quarantineIfPresent(directory, candidate, fileSystem, options);
  }
  return undefined;
}

/** Recover the highest supported generation from the bounded canonical candidate set. */
export async function recoverLifetimeGeneration(
  directory: string,
  options: LifetimePublicationOptions = {},
): Promise<RecoveryOutcome> {
  try {
    const fileSystem = resolveLifetimeFileSystem(options.fileSystem);
    const binding = await validateLifetimeDirectoryBinding(directory, fileSystem);
    const names = await recoveryNames(binding.directory, fileSystem);
    if (!names) return { status: "recoveryRequired", reason: "corruptCandidates" };
    if (names.length === 0) return { status: "empty" };

    const candidates: CandidateState[] = [];
    for (const name of names) {
      const rank = name === PRIMARY_FILENAME ? 0 : name === BACKUP_FILENAME ? 1 : 2;
      candidates.push(await readCandidate(resolve(binding.directory, name), rank, fileSystem));
    }

    if (candidates.some((candidate) => candidate.status === "unknownNewer")) {
      return { status: "recoveryRequired", reason: "unknownSchema" };
    }
    if (candidates.some((candidate) => candidate.status === "ioFailure")) {
      return { status: "ioFailure" };
    }
    const unsafe = candidates.some((candidate) =>
      candidate.status === "corrupt" && candidate.source === undefined);
    if (unsafe) return { status: "recoveryRequired", reason: "corruptCandidates" };

    const valid = candidates
      .filter((candidate): candidate is Extract<CandidateState, { readonly status: "valid" }> =>
        candidate.status === "valid")
      .sort((left, right) =>
        right.root.generation - left.root.generation ||
        left.rank - right.rank ||
        left.path.localeCompare(right.path));
    const winner = valid[0];
    if (!winner) {
      if (candidates.every((candidate) => candidate.status === "missing")) {
        return { status: "empty" };
      }
      for (const candidate of candidates) {
        await quarantineIfPresent(binding.directory, candidate, fileSystem, options);
      }
      return { status: "recoveryRequired", reason: "corruptCandidates" };
    }

    const primaryPath = resolve(binding.directory, PRIMARY_FILENAME);
    if (winner.path === primaryPath) {
      const canonical = await readCandidate(primaryPath, 0, fileSystem);
      if (canonical.status === "ioFailure") return { status: "ioFailure" };
      if (canonical.status !== "valid" || canonical.root.generation !== winner.root.generation ||
          !canonical.content.equals(winner.content)) {
        return { status: "recoveryRequired", reason: "corruptCandidates" };
      }
      // Cleanup follows final canonical validation so no candidate is discarded
      // while it could still be needed to establish the winning generation.
      const cleanup = await cleanupRecoveryCandidates(
        binding.directory,
        candidates.map((candidate) => candidate.path),
        winner.root.generation,
        fileSystem,
        options,
      );
      if (cleanup) return cleanup;
      const finalPrimary = await readCandidate(primaryPath, 0, fileSystem);
      if (finalPrimary.status === "ioFailure") return { status: "ioFailure" };
      if (finalPrimary.status !== "valid" ||
          finalPrimary.root.generation !== winner.root.generation ||
          !finalPrimary.content.equals(winner.content)) {
        return { status: "recoveryRequired", reason: "corruptCandidates" };
      }
      return {
        status: "ready",
        root: finalPrimary.root,
        generation: finalPrimary.root.generation,
      };
    }

    const corruptPrimary = candidates.find((candidate) =>
      candidate.status === "corrupt" && candidate.path === primaryPath);
    if (corruptPrimary) {
      // This is a safety move required to create the canonical primary; the
      // selected backup/temp winner remains eligible throughout it.
      await quarantineIfPresent(binding.directory, corruptPrimary, fileSystem, options);
    }
    const currentPrimary = valid.find((candidate) => candidate.path === primaryPath);
    const published = await publishLifetimeGeneration(
      binding.directory,
      winner.root,
      currentPrimary?.root.generation ?? 0,
      options,
    );
    if (published.status === "indeterminate") {
      return { status: "recoveryRequired", reason: "indeterminatePublication" };
    }
    if (published.status === "notPublished") {
      return { status: "ioFailure" };
    }

    const finalPrimary = await readCandidate(primaryPath, 0, fileSystem);
    if (finalPrimary.status === "ioFailure") return { status: "ioFailure" };
    if (finalPrimary.status !== "valid" ||
        finalPrimary.root.generation !== published.generation ||
        !finalPrimary.content.equals(winner.content)) {
      return { status: "recoveryRequired", reason: "indeterminatePublication" };
    }
    const cleanup = await cleanupRecoveryCandidates(
      binding.directory,
      candidates.map((candidate) => candidate.path),
      published.generation,
      fileSystem,
      options,
    );
    if (cleanup) return cleanup;
    return {
      status: "ready",
      root: finalPrimary.root,
      generation: finalPrimary.root.generation,
    };
  } catch (error) {
    return recoveryError(error);
  }
}
