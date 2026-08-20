import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";

import {
  publishLifetimeGeneration,
  recoverLifetimeGeneration,
  type LifetimePublicationOptions,
} from "../../../dist/observability/lifetime-publication.js";
import {
  resolveLifetimeFileSystem,
} from "../../../dist/observability/lifetime-evidence.js";
import {
  MAX_STORE_BYTES,
  parseDurableLifetimeRoot,
  type DurableLifetimeRoot,
} from "../../../dist/observability/lifetime-types.js";

const PRIMARY = "sdl-observability-lifetime.json";
const BACKUP = "sdl-observability-lifetime.backup.json";
const TEMP_PREFIX = "sdl-observability-lifetime.temp.";
const ISO = "2026-08-20T01:02:03.004Z";
const temporaryDirectories: string[] = [];

function root(generation: number, updatedAt = ISO): DurableLifetimeRoot {
  return parseDurableLifetimeRoot({
    schemaVersion: 1,
    generation,
    updatedAt,
    processPeaks: null,
    repositories: {},
  });
}

function serialized(value: DurableLifetimeRoot): string {
  return JSON.stringify(parseDurableLifetimeRoot(value));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sdl-lifetime-publication-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function generationAt(directory: string, name = PRIMARY): Promise<number> {
  const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
  return parseDurableLifetimeRoot(value).generation;
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function publicationEvidence(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => name.startsWith(
      "sdl-observability-lifetime.evidence.v1.validated-supported.publication.",
    ))
    .sort();
}

after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("lifetime publication", () => {
  it("publishes exact validated bytes through a random exclusive 0600 temp", async () => {
    const directory = await temporaryDirectory();
    const opens: Array<{ path: string; flags: string | number; mode: number | undefined }> = [];
    const options: LifetimePublicationOptions = {
      randomBytes: () => Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      fileSystem: {
        open: async (path, flags, mode) => {
          opens.push({ path: String(path), flags, mode });
          return open(path, flags, mode);
        },
      },
    };

    const result = await publishLifetimeGeneration(directory, root(1), 0, options);

    assert.equal(result.status, "committed");
    assert.equal(await readFile(join(directory, PRIMARY), "utf8"), serialized(root(1)));
    const tempOpen = opens.find((entry) => basename(entry.path).startsWith(TEMP_PREFIX));
    assert.deepEqual(tempOpen && { flags: tempOpen.flags, mode: tempOpen.mode }, {
      flags: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      assert.equal((await lstat(join(directory, PRIMARY))).mode & 0o777, 0o600);
    }
  });

  it("publishes generation zero into an empty directory with full durability ordering", async () => {
    const directory = await temporaryDirectory();
    const stages: string[] = [];

    const result = await publishLifetimeGeneration(directory, root(0), 0, {
      fault: (stage) => { stages.push(stage); },
    });

    assert.deepEqual(result, { status: "committed", root: root(0), generation: 0 });
    assert.equal(await generationAt(directory), 0);
    assert.deepEqual(stages, [
      "beforeTempCreate",
      "tempWrite",
      "tempSync",
      "tempClose",
      "tempReopen",
      "tempValidation",
      "afterTempValidation",
      "backupDisposition",
      "tempToPrimary",
      "afterTempToPrimary",
      "directoryFlush",
      "finalPrimaryReopen",
      "finalPrimaryRead",
      "finalPrimaryValidation",
    ]);
  });

  it("rejects stale and oversized generations before replacing a valid primary", async () => {
    const directory = await temporaryDirectory();
    assert.equal((await publishLifetimeGeneration(directory, root(4), 0)).status, "committed");
    const before = await readFile(join(directory, PRIMARY));

    assert.equal((await publishLifetimeGeneration(directory, root(3), 4)).status, "notPublished");
    const oversized: DurableLifetimeRoot = {
      ...root(5),
      updatedAt: "x".repeat(MAX_STORE_BYTES),
    };
    assert.equal((await publishLifetimeGeneration(directory, oversized, 4)).status, "notPublished");
    assert.deepEqual(await readFile(join(directory, PRIMARY)), before);
  });

  it("rejects oversized reads before opening or parsing the candidate", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), Buffer.alloc(MAX_STORE_BYTES + 1));
    let primaryOpens = 0;

    const result = await recoverLifetimeGeneration(directory, {
      fileSystem: {
        open: async (path, flags, mode) => {
          if (String(path) === join(directory, PRIMARY)) primaryOpens++;
          return open(path, flags, mode);
        },
      },
    });

    assert.deepEqual(result, { status: "recoveryRequired", reason: "corruptCandidates" });
    assert.equal(primaryOpens, 0);
  });

  it("refuses symlink and non-regular publication candidates", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    await writeFile(target, serialized(root(1)));
    await symlink(target, join(directory, PRIMARY), "file");
    assert.equal((await publishLifetimeGeneration(directory, root(2), 1)).status, "notPublished");
    assert.equal((await recoverLifetimeGeneration(directory)).status, "recoveryRequired");

    const other = await temporaryDirectory();
    await mkdir(join(other, `${TEMP_PREFIX}${"a".repeat(32)}.json`));
    assert.equal((await recoverLifetimeGeneration(other)).status, "recoveryRequired");
  });

  it("orders every flush, close, reopen, and validation stage before commit", async () => {
    const directory = await temporaryDirectory();
    const stages: string[] = [];
    const result = await publishLifetimeGeneration(directory, root(1), 0, {
      fault: (stage) => { stages.push(stage); },
    });

    assert.equal(result.status, "committed");
    assert.deepEqual(stages, [
      "beforeTempCreate",
      "tempWrite",
      "tempSync",
      "tempClose",
      "tempReopen",
      "tempValidation",
      "afterTempValidation",
      "backupDisposition",
      "tempToPrimary",
      "afterTempToPrimary",
      "directoryFlush",
      "finalPrimaryReopen",
      "finalPrimaryRead",
      "finalPrimaryValidation",
    ]);
  });

  it("classifies every injected stage around the rename commit boundary", async () => {
    const beforeCommit = [
      "beforeTempCreate",
      "tempWrite",
      "tempSync",
      "tempClose",
      "tempReopen",
      "tempValidation",
      "afterTempValidation",
      "backupDisposition",
      "afterPrimaryToBackup",
      "tempToPrimary",
    ] as const;
    const afterCommit = [
      "afterTempToPrimary",
      "directoryFlush",
      "finalPrimaryReopen",
      "finalPrimaryRead",
      "finalPrimaryValidation",
    ] as const;

    for (const stage of beforeCommit) {
      const directory = await temporaryDirectory();
      assert.equal((await publishLifetimeGeneration(directory, root(1), 0)).status, "committed");
      const result = await publishLifetimeGeneration(directory, root(2), 1, {
        fault: (current) => {
          if (current === stage) throw new Error(stage);
        },
      });
      assert.equal(result.status, "notPublished", stage);
      assert.equal(await generationAt(directory), 1, stage);
      assert.deepEqual(await recoverLifetimeGeneration(directory), {
        status: "ready",
        root: root(1),
        generation: 1,
      }, stage);
    }

    for (const stage of afterCommit) {
      const directory = await temporaryDirectory();
      assert.equal((await publishLifetimeGeneration(directory, root(1), 0)).status, "committed");
      const result = await publishLifetimeGeneration(directory, root(2), 1, {
        fault: (current) => {
          if (current === stage) throw new Error(stage);
        },
      });
      assert.equal(result.status, "indeterminate", stage);
      assert.deepEqual(await recoverLifetimeGeneration(directory), {
        status: "ready",
        root: root(2),
        generation: 2,
      }, stage);
    }
  });

  it("treats a rename error after replacement as indeterminate", async () => {
    const directory = await temporaryDirectory();
    assert.equal((await publishLifetimeGeneration(directory, root(1), 0)).status, "committed");
    const base = resolveLifetimeFileSystem();
    const result = await publishLifetimeGeneration(directory, root(2), 1, {
      fileSystem: {
        rename: async (source, target) => {
          await base.rename(source, target);
          if (String(target) === join(directory, PRIMARY)) throw new Error("rename acknowledgement lost");
        },
      },
    });

    assert.equal(result.status, "indeterminate");
    assert.equal(await generationAt(directory), 2);
  });

  it("preserves a detected out-of-protocol primary replacement", async () => {
    const directory = await temporaryDirectory();
    assert.equal((await publishLifetimeGeneration(directory, root(1), 0)).status, "committed");
    const replacement = Buffer.from("replacement");
    const result = await publishLifetimeGeneration(directory, root(2), 1, {
      fault: async (stage) => {
        if (stage !== "afterTempValidation") return;
        await rename(join(directory, PRIMARY), join(directory, "displaced"));
        await writeFile(join(directory, PRIMARY), replacement);
      },
    });

    assert.equal(result.status, "notPublished");
    assert.deepEqual(await readFile(join(directory, PRIMARY)), replacement);
  });

  it("restores the old primary when claim cleanup fails after its physical move", async () => {
    const cleanupNames = [
      ".sdl-observability-lifetime.claim-source.",
      ".sdl-observability-lifetime.claim-cleanup.",
      ".sdl-observability-lifetime.claim-record.",
    ] as const;

    for (const cleanupName of cleanupNames) {
      const directory = await temporaryDirectory();
      assert.equal((await publishLifetimeGeneration(directory, root(1), 0)).status, "committed");
      const base = resolveLifetimeFileSystem();
      let primaryMoved = false;
      let failed = false;
      const result = await publishLifetimeGeneration(directory, root(2), 1, {
        fileSystem: {
          rename: async (source, target) => {
            await base.rename(source, target);
            if (String(target) === join(directory, BACKUP)) primaryMoved = true;
          },
          unlink: async (path) => {
            if (primaryMoved && !failed && basename(String(path)).startsWith(cleanupName)) {
              failed = true;
              throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
            }
            await base.unlink(path);
          },
        },
      });

      assert.equal(failed, true, cleanupName);
      assert.equal(result.status, "notPublished", cleanupName);
      assert.equal(await generationAt(directory), 1, cleanupName);
      assert.equal((await readdir(directory)).some((name) => name.startsWith(TEMP_PREFIX)), false);
      assert.deepEqual(await recoverLifetimeGeneration(directory), {
        status: "ready",
        root: root(1),
        generation: 1,
      }, cleanupName);
    }
  });

  it("returns indeterminate when a valid pre-commit temp cannot be neutralized", async () => {
    const directory = await temporaryDirectory();
    assert.equal((await publishLifetimeGeneration(directory, root(1), 0)).status, "committed");
    const base = resolveLifetimeFileSystem();
    const result = await publishLifetimeGeneration(directory, root(2), 1, {
      fault: (stage) => {
        if (stage === "afterTempValidation") throw new Error("stop before commit");
      },
      fileSystem: {
        rename: async (source, target) => {
          if (basename(String(source)).startsWith(TEMP_PREFIX) &&
              basename(String(target)).startsWith(".sdl-observability-lifetime.aux-delete.")) {
            throw Object.assign(new Error("temp neutralization failed"), { code: "EIO" });
          }
          await base.rename(source, target);
        },
      },
    });

    assert.deepEqual(result, {
      status: "indeterminate",
      reason: "tempNeutralizationUncertain",
      stage: "tempCleanup",
    });
    assert.equal((await readdir(directory)).some((name) => name.startsWith(TEMP_PREFIX)), true);
    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(2),
      generation: 2,
    });
  });

  it("does not claim notPublished when claim cleanup and temp neutralization both fail", async () => {
    const directory = await temporaryDirectory();
    assert.equal((await publishLifetimeGeneration(directory, root(1), 0)).status, "committed");
    const base = resolveLifetimeFileSystem();
    let primaryMoved = false;
    let claimCleanupFailed = false;
    const result = await publishLifetimeGeneration(directory, root(2), 1, {
      fileSystem: {
        rename: async (source, target) => {
          if (basename(String(source)).startsWith(TEMP_PREFIX) &&
              basename(String(target)).startsWith(".sdl-observability-lifetime.aux-delete.")) {
            throw Object.assign(new Error("temp remains recoverable"), { code: "EIO" });
          }
          await base.rename(source, target);
          if (String(target) === join(directory, BACKUP)) primaryMoved = true;
        },
        unlink: async (path) => {
          if (primaryMoved && !claimCleanupFailed &&
              basename(String(path)).startsWith(".sdl-observability-lifetime.claim-source.")) {
            claimCleanupFailed = true;
            throw Object.assign(new Error("claim cleanup failed"), { code: "EIO" });
          }
          await base.unlink(path);
        },
      },
    });

    assert.equal(claimCleanupFailed, true);
    assert.deepEqual(result, {
      status: "indeterminate",
      reason: "tempNeutralizationUncertain",
      stage: "tempCleanup",
    });
    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(2),
      generation: 2,
    });
  });

  it("rejects a candidate older than an existing backup before mutation", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(1)));
    await writeFile(join(directory, BACKUP), serialized(root(3)));
    const before = new Map<string, Buffer>();
    for (const name of await readdir(directory)) before.set(name, await readFile(join(directory, name)));

    assert.deepEqual(await publishLifetimeGeneration(directory, root(2), 1), {
      status: "notPublished",
      reason: "staleGeneration",
    });
    assert.deepEqual((await readdir(directory)).sort(), [...before.keys()].sort());
    for (const [name, content] of before) {
      assert.deepEqual(await readFile(join(directory, name)), content);
    }
  });

  it("rejects equal-generation backup content conflicts before mutation", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(1)));
    await writeFile(join(directory, BACKUP), serialized(root(2, "2026-08-20T02:02:03.004Z")));
    const before = await readFile(join(directory, BACKUP));

    assert.deepEqual(await publishLifetimeGeneration(directory, root(2), 1), {
      status: "notPublished",
      reason: "generationConflict",
    });
    assert.deepEqual(await readFile(join(directory, BACKUP)), before);
    assert.equal((await readdir(directory)).some((name) => name.startsWith(TEMP_PREFIX)), false);
  });

  it("makes an exact equal primary idempotent and rejects divergent equal content", async () => {
    const directory = await temporaryDirectory();
    const authoritative = root(2);
    assert.equal((await publishLifetimeGeneration(directory, authoritative, 0)).status, "committed");
    const beforeNames = (await readdir(directory)).sort();
    const beforePrimary = await readFile(join(directory, PRIMARY));

    assert.deepEqual(await publishLifetimeGeneration(directory, authoritative, 2), {
      status: "committed",
      root: authoritative,
      generation: 2,
    });
    assert.deepEqual((await readdir(directory)).sort(), beforeNames);
    assert.deepEqual(await readFile(join(directory, PRIMARY)), beforePrimary);

    assert.deepEqual(
      await publishLifetimeGeneration(
        directory,
        root(2, "2026-08-20T02:02:03.004Z"),
        2,
      ),
      { status: "notPublished", reason: "generationConflict" },
    );
    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: authoritative,
      generation: 2,
    });
  });

  it("keeps a committed primary valid when duplicate-backup cleanup fails before its move", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, BACKUP), serialized(root(0)));
    const base = resolveLifetimeFileSystem();
    let cleanupAttempted = false;

    const result = await publishLifetimeGeneration(directory, root(0), 0, {
      fileSystem: {
        rename: async (source, target) => {
          if (String(source) === join(directory, BACKUP) &&
              basename(String(target)).startsWith("sdl-observability-lifetime.evidence.")) {
            cleanupAttempted = true;
            throw Object.assign(new Error("permanent pre-move cleanup failure"), { code: "EIO" });
          }
          await base.rename(source, target);
        },
      },
    });

    assert.equal(cleanupAttempted, true);
    assert.deepEqual(result, {
      status: "indeterminate",
      reason: "publicationCommitUncertain",
      stage: "commit",
    });
    assert.equal(await generationAt(directory), 0);
    assert.equal(await generationAt(directory, BACKUP), 0);
    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(0),
      generation: 0,
    });
  });

  it("keeps a committed primary valid when duplicate-backup claim cleanup fails after its move", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, BACKUP), serialized(root(0)));
    const base = resolveLifetimeFileSystem();
    let backupMoved = false;
    let cleanupFailed = false;

    const result = await publishLifetimeGeneration(directory, root(0), 0, {
      fileSystem: {
        rename: async (source, target) => {
          await base.rename(source, target);
          if (String(source) === join(directory, BACKUP) &&
              basename(String(target)).startsWith("sdl-observability-lifetime.evidence.")) {
            backupMoved = true;
          }
        },
        unlink: async (path) => {
          const name = basename(String(path));
          if (backupMoved && (name.startsWith(".sdl-observability-lifetime.claim-source.") ||
              name.startsWith(".sdl-observability-lifetime.claim-cleanup.") ||
              name.startsWith(".sdl-observability-lifetime.claim-record."))) {
            cleanupFailed = true;
            throw Object.assign(new Error("permanent post-move cleanup failure"), { code: "EIO" });
          }
          await base.unlink(path);
        },
      },
    });

    assert.equal(backupMoved, true);
    assert.equal(cleanupFailed, true);
    assert.deepEqual(result, {
      status: "indeterminate",
      reason: "publicationCommitUncertain",
      stage: "commit",
    });
    assert.equal(await generationAt(directory), 0);
    assert.equal(await missing(join(directory, BACKUP)), true);
    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(0),
      generation: 0,
    });
  });
});

describe("lifetime recovery", () => {
  it("distinguishes an uninitialized directory from corrupt candidates", async () => {
    const directory = await temporaryDirectory();
    assert.deepEqual(await recoverLifetimeGeneration(directory), { status: "empty" });
  });

  it("recovers a backup-only generation zero into the canonical primary", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, BACKUP), serialized(root(0)));

    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(0),
      generation: 0,
    });
    assert.equal(await generationAt(directory), 0);
  });

  it("recovers a temp-only generation zero into the canonical primary", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, `${TEMP_PREFIX}${"0".repeat(32)}.json`),
      serialized(root(0)),
    );

    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(0),
      generation: 0,
    });
    assert.equal(await generationAt(directory), 0);
  });

  it("reports coded read failures as operational rather than corrupt", async () => {
    for (const code of ["EIO", "EMFILE"] as const) {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, PRIMARY), serialized(root(1)));
      const base = resolveLifetimeFileSystem();
      assert.deepEqual(await recoverLifetimeGeneration(directory, {
        fileSystem: {
          open: async (path, flags, mode) => {
            if (String(path) === join(directory, PRIMARY)) {
              throw Object.assign(new Error(code), { code });
            }
            return base.open(path, flags, mode);
          },
        },
      }), { status: "ioFailure" }, code);
    }
  });

  it("preserves a backup winner across every interrupted recovery stage", async () => {
    const stages = [
      "beforeTempCreate",
      "tempWrite",
      "tempSync",
      "tempClose",
      "tempReopen",
      "tempValidation",
      "afterTempValidation",
      "backupDisposition",
      "afterPrimaryToBackup",
      "tempToPrimary",
      "afterTempToPrimary",
      "directoryFlush",
      "finalPrimaryReopen",
      "finalPrimaryRead",
      "finalPrimaryValidation",
    ] as const;

    for (const stage of stages) {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, PRIMARY), serialized(root(2)));
      await writeFile(join(directory, BACKUP), serialized(root(3)));
      const interrupted = await recoverLifetimeGeneration(directory, {
        fault: (current) => {
          if (current === stage) throw new Error(stage);
        },
      });
      assert.notDeepEqual(interrupted, {
        status: "recoveryRequired",
        reason: "corruptCandidates",
      }, stage);
      assert.deepEqual(await recoverLifetimeGeneration(directory), {
        status: "ready",
        root: root(3),
        generation: 3,
      }, stage);
    }
  });

  it("preserves a backup winner when lower-primary evidence claim cleanup fails", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(2)));
    await writeFile(join(directory, BACKUP), serialized(root(3)));
    const base = resolveLifetimeFileSystem();
    let primaryDispositionAttempted = false;
    let failed = false;
    const interrupted = await recoverLifetimeGeneration(directory, {
      fileSystem: {
        rename: async (source, target) => {
          await base.rename(source, target);
          if (String(source) === join(directory, PRIMARY) &&
              basename(String(target)).startsWith("sdl-observability-lifetime.evidence.")) {
            primaryDispositionAttempted = true;
          }
        },
        unlink: async (path) => {
          if (primaryDispositionAttempted && !failed &&
              basename(String(path)).startsWith(".sdl-observability-lifetime.claim-source.")) {
            failed = true;
            throw Object.assign(new Error("claim cleanup failure"), { code: "EIO" });
          }
          await base.unlink(path);
        },
      },
    });

    assert.equal(failed, true);
    assert.notDeepEqual(interrupted, {
      status: "recoveryRequired",
      reason: "corruptCandidates",
    });
    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(3),
      generation: 3,
    });
  });

  it("selects the highest primary, backup, or bounded temp deterministically", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(2)), { mode: 0o600 });
    await writeFile(join(directory, BACKUP), serialized(root(3)), { mode: 0o600 });
    await writeFile(
      join(directory, `${TEMP_PREFIX}${"a".repeat(32)}.json`),
      serialized(root(4)),
      { mode: 0o600 },
    );

    const result = await recoverLifetimeGeneration(directory);

    assert.deepEqual(result, { status: "ready", root: root(4), generation: 4 });
    assert.equal(await generationAt(directory), 4);
  });

  it("keeps primary authoritative for a deterministic equal-generation tie", async () => {
    const directory = await temporaryDirectory();
    const primary = root(3);
    const backup = root(3, "2026-08-20T02:02:03.004Z");
    await writeFile(join(directory, PRIMARY), serialized(primary), { mode: 0o600 });
    await writeFile(join(directory, BACKUP), serialized(backup), { mode: 0o600 });

    const result = await recoverLifetimeGeneration(directory);

    assert.deepEqual(result, { status: "ready", root: primary, generation: 3 });
    assert.deepEqual(parseDurableLifetimeRoot(JSON.parse(await readFile(join(directory, PRIMARY), "utf8"))), primary);
  });

  it("fails closed without mutation when more than four candidates exist", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(1)));
    for (let index = 0; index < 4; index++) {
      await writeFile(
        join(directory, `${TEMP_PREFIX}${String(index).padStart(32, "0")}.json`),
        serialized(root(index + 2)),
      );
    }
    const before = (await readdir(directory)).sort();

    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "recoveryRequired",
      reason: "corruptCandidates",
    });
    assert.deepEqual((await readdir(directory)).sort(), before);
  });

  it("preserves unknown newer schemas byte-for-byte and excludes them from recovery", async () => {
    const directory = await temporaryDirectory();
    const unknown = Buffer.from('{"schemaVersion":2,"generation":99,"opaque":"future"}');
    await writeFile(join(directory, PRIMARY), unknown);
    await writeFile(join(directory, BACKUP), serialized(root(4)));

    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "recoveryRequired",
      reason: "unknownSchema",
    });
    assert.deepEqual(await readFile(join(directory, PRIMARY)), unknown);
    assert.equal(await generationAt(directory, BACKUP), 4);
  });

  it("recognizes every numeric newer schema before safe-integer supported parsing", async () => {
    const unknown = Buffer.from(
      '{"schemaVersion":9007199254740992,"generation":99,"opaque":"future"}',
    );
    const placements = [PRIMARY, BACKUP, `${TEMP_PREFIX}${"b".repeat(32)}.json`] as const;

    for (const placement of placements) {
      const directory = await temporaryDirectory();
      if (placement !== PRIMARY) await writeFile(join(directory, PRIMARY), serialized(root(4)));
      if (placement !== BACKUP) await writeFile(join(directory, BACKUP), serialized(root(3)));
      await writeFile(join(directory, placement), unknown);
      const before = new Map<string, Buffer>();
      for (const name of await readdir(directory)) {
        before.set(name, await readFile(join(directory, name)));
      }

      assert.deepEqual(await recoverLifetimeGeneration(directory), {
        status: "recoveryRequired",
        reason: "unknownSchema",
      }, placement);
      for (const [name, content] of before) {
        assert.deepEqual(await readFile(join(directory, name)), content, `${placement}:${name}`);
      }
    }
  });

  it("treats nonnumeric schema versions as corrupt rather than unknown newer", async () => {
    for (const schemaVersion of ["2", null, { future: 2 }]) {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, PRIMARY), serialized(root(2)));
      await writeFile(join(directory, BACKUP), JSON.stringify({ schemaVersion }));

      assert.deepEqual(await recoverLifetimeGeneration(directory), {
        status: "ready",
        root: root(2),
        generation: 2,
      });
      assert.equal((await publicationEvidence(directory)).length, 1);
    }
  });

  it("quarantines a lower canonical backup after the higher primary is safe", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(2)));
    await writeFile(join(directory, BACKUP), serialized(root(1)));

    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(2),
      generation: 2,
    });
    assert.equal(await missing(join(directory, BACKUP)), true);
    assert.equal((await publicationEvidence(directory)).length, 1);
  });

  it("quarantines every lower generation after promoting a temp winner", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(2)));
    await writeFile(join(directory, BACKUP), serialized(root(1)));
    await writeFile(
      join(directory, `${TEMP_PREFIX}${"c".repeat(32)}.json`),
      serialized(root(3)),
    );

    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "ready",
      root: root(3),
      generation: 3,
    });
    assert.equal(await missing(join(directory, BACKUP)), true);
    const evidence = await publicationEvidence(directory);
    assert.equal(evidence.length, 3);
    assert.ok(evidence.length <= 8);
  });

  it("quarantines corrupt supported candidates through the shared bounded evidence set", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), '{"schemaVersion":1}');

    assert.deepEqual(await recoverLifetimeGeneration(directory), {
      status: "recoveryRequired",
      reason: "corruptCandidates",
    });
    const evidence = (await readdir(directory)).filter((name) =>
      name.startsWith("sdl-observability-lifetime.evidence."));
    assert.equal(evidence.length, 1);
    assert.ok(evidence.length <= 8);
  });

  it("ignores arbitrary files and rejects a non-canonical directory boundary", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(1)));
    for (let index = 0; index < 20; index++) {
      await writeFile(join(directory, `arbitrary-${index}`), randomBytes(8));
    }
    assert.equal((await recoverLifetimeGeneration(directory)).status, "ready");

    if (process.platform !== "win32") {
      const parent = await temporaryDirectory();
      const alias = join(parent, "alias");
      await symlink(directory, alias, "dir");
      assert.deepEqual(await recoverLifetimeGeneration(alias), {
        status: "recoveryRequired",
        reason: "corruptCandidates",
      });
    }
  });

  it("does not depend on write permission bits while validating existing bytes", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    await writeFile(join(directory, PRIMARY), serialized(root(1)), { mode: 0o600 });
    await chmod(join(directory, PRIMARY), constants.S_IRUSR);
    assert.equal((await recoverLifetimeGeneration(directory)).status, "ready");
  });
});
