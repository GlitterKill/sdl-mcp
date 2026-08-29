import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  resolveLifetimeFileSystem,
  type LifetimeFileSystemOverrides,
} from "../../../dist/observability/lifetime-evidence.js";
import {
  acquireLifetimeLease,
  LIFETIME_LOCK_FILENAME,
  releaseLifetimeLease,
} from "../../../dist/observability/lifetime-lock.js";
import {
  publishLifetimeGeneration,
} from "../../../dist/observability/lifetime-publication.js";
import {
  openLifetimeStore,
} from "../../../dist/observability/lifetime-store.js";
import {
  parseDurableLifetimeRoot,
  type DurableLifetimeRoot,
} from "../../../dist/observability/lifetime-types.js";

const PRIMARY = "sdl-observability-lifetime.json";
const TEMP_PREFIX = "sdl-observability-lifetime.temp.";
const ISO_1 = "2026-08-20T01:02:03.004Z";
const ISO_2 = "2026-08-20T01:03:04.005Z";
const ISO_3 = "2026-08-20T01:04:05.006Z";
const temporaryDirectories: string[] = [];

function root(generation: number, updatedAt = ISO_1): DurableLifetimeRoot {
  return parseDurableLifetimeRoot({
    schemaVersion: 1,
    generation,
    updatedAt,
    processPeaks: null,
    repositories: {},
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "sdl-lifetime-store-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function lockCreatedAt(directory: string): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(join(directory, LIFETIME_LOCK_FILENAME), "utf8"),
  );
  assert.ok(value && typeof value === "object");
  return String(Reflect.get(value, "createdAt"));
}

async function snapshotDirectory(directory: string): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  for (const name of (await readdir(directory)).sort()) {
    snapshot.set(name, await readFile(join(directory, name)));
  }
  return snapshot;
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

function matchesCloseError(expected: object): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "LifetimeStoreCloseError");
    assert.deepEqual(Reflect.get(error, "outcome"), expected);
    return true;
  };
}

after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("lifetime store", () => {
  it("opens writer/read-only empty states with exact discriminants and key order", async () => {
    const directory = await temporaryDirectory();
    const writer = await openLifetimeStore({ directory, pid: 41 });
    assert.deepEqual(writer.state(), { mode: "writer", root: null, generation: null });
    assert.deepEqual(Object.keys(writer.state()), ["mode", "root", "generation"]);
    const beforeWriterRefresh = await snapshotDirectory(directory);
    assert.deepEqual(await writer.refreshReadOnly(), { status: "unchanged" });
    assert.deepEqual(await snapshotDirectory(directory), beforeWriterRefresh);

    const secondary = await openLifetimeStore({
      directory,
      pid: 42,
      pidExists: () => true,
    });
    assert.deepEqual(secondary.state(), { mode: "readOnly", root: null, generation: null });
    assert.deepEqual(Object.keys(secondary.state()), ["mode", "root", "generation"]);

    await secondary.close();
    await writer.close();
  });

  it("serializes checkpoint/reset publications and captures snapshots at enqueue", async () => {
    const directory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    const committed: number[] = [];
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let blocked = false;
    const fs: LifetimeFileSystemOverrides = {
      open: async (path, flags, mode) => {
        if (!blocked && basename(String(path)).startsWith(TEMP_PREFIX)) {
          blocked = true;
          enteredFirst();
          await firstGate;
        }
        return base.open(path, flags, mode);
      },
      rename: async (source, target) => {
        if (basename(String(source)).startsWith(TEMP_PREFIX) &&
            basename(String(target)) === PRIMARY) {
          const value: unknown = JSON.parse(await readFile(source, "utf8"));
          committed.push(parseDurableLifetimeRoot(value).generation);
        }
        await base.rename(source, target);
      },
    };
    const store = await openLifetimeStore({ directory, pid: 43, fs });

    const first = store.checkpoint(root(0));
    await firstEntered;
    const mutable = root(1, ISO_2);
    const reset = store.reset(mutable);
    const final = store.checkpoint(root(2, ISO_3));
    mutable.generation = 99;
    mutable.updatedAt = ISO_3;
    releaseFirst();

    assert.equal((await first).status, "committed");
    const resetOutcome = await reset;
    assert.deepEqual(resetOutcome, { status: "committed", root: root(1, ISO_2), generation: 1 });
    assert.equal((await final).status, "committed");
    assert.deepEqual(committed, [0, 1, 2]);
    assert.deepEqual(store.state(), { mode: "writer", root: root(2, ISO_3), generation: 2 });
    await store.close();
  });

  it("rejects stale and conflicting queued generations before filesystem mutation", async () => {
    const directory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    const published: number[] = [];
    const fs: LifetimeFileSystemOverrides = {
      rename: async (source, target) => {
        if (basename(String(source)).startsWith(TEMP_PREFIX) &&
            basename(String(target)) === PRIMARY) {
          const value: unknown = JSON.parse(await readFile(source, "utf8"));
          published.push(parseDurableLifetimeRoot(value).generation);
        }
        await base.rename(source, target);
      },
    };
    const store = await openLifetimeStore({ directory, pid: 44, fs });
    const newest = store.reset(root(2, ISO_2));
    const stale = store.checkpoint(root(1));
    const conflict = store.checkpoint(root(2, ISO_3));

    assert.equal((await newest).status, "committed");
    assert.deepEqual(await stale, { status: "notPublished", reason: "staleGeneration" });
    assert.deepEqual(await conflict, { status: "notPublished", reason: "generationConflict" });
    assert.deepEqual(published, [2]);
    assert.equal(store.state().generation, 2);
    await store.close();
  });

  it("uses only committed authority after definitely-not-published queued writes", async () => {
    const lowerDirectory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    let failNextTemp = false;
    const lowerStore = await openLifetimeStore({
      directory: lowerDirectory,
      pid: 60,
      fs: {
        open: async (path, flags, mode) => {
          if (failNextTemp && basename(String(path)).startsWith(TEMP_PREFIX)) {
            failNextTemp = false;
            throw Object.assign(new Error("definite publication failure"), { code: "EIO" });
          }
          return base.open(path, flags, mode);
        },
      },
    });
    assert.equal((await lowerStore.checkpoint(root(0))).status, "committed");
    failNextTemp = true;
    const failedHigher = lowerStore.checkpoint(root(2, ISO_3));
    const queuedLower = lowerStore.checkpoint(root(1, ISO_2));

    assert.deepEqual(await failedHigher, { status: "notPublished", reason: "ioFailure" });
    assert.equal((await queuedLower).status, "committed");
    assert.deepEqual(lowerStore.state(), {
      mode: "writer",
      root: root(1, ISO_2),
      generation: 1,
    });
    await lowerStore.close();

    const retryDirectory = await temporaryDirectory();
    failNextTemp = false;
    const retryStore = await openLifetimeStore({
      directory: retryDirectory,
      pid: 61,
      fs: {
        open: async (path, flags, mode) => {
          if (failNextTemp && basename(String(path)).startsWith(TEMP_PREFIX)) {
            failNextTemp = false;
            throw Object.assign(new Error("definite reset failure"), { code: "EIO" });
          }
          return base.open(path, flags, mode);
        },
      },
    });
    assert.equal((await retryStore.checkpoint(root(0))).status, "committed");
    failNextTemp = true;
    const failedReset = retryStore.reset(root(2, ISO_2));
    const updatedRetry = retryStore.reset(root(2, ISO_3));

    assert.deepEqual(await failedReset, { status: "notPublished", reason: "ioFailure" });
    assert.deepEqual(await updatedRetry, {
      status: "committed",
      root: root(2, ISO_3),
      generation: 2,
    });
    await retryStore.close();
  });

  it("queues invalid snapshots, degrades without mutation, and permits a valid retry", async () => {
    const directory = await temporaryDirectory();
    const store = await openLifetimeStore({ directory, pid: 62 });
    const before = await snapshotDirectory(directory);
    const invalid = root(0);
    invalid.generation = -1;
    const invalidOutcome = store.checkpoint(invalid);
    invalid.generation = 0;

    assert.deepEqual(await invalidOutcome, {
      status: "notPublished",
      reason: "invalidGeneration",
    });
    assert.deepEqual(store.state(), { mode: "degraded", root: null, generation: null });
    assert.deepEqual(await snapshotDirectory(directory), before);
    assert.equal((await store.checkpoint(root(0))).status, "committed");
    assert.deepEqual(store.state(), { mode: "writer", root: root(0), generation: 0 });
    await store.close();
  });

  it("refreshes the lease only after commits and keeps prior authority across a retry", async () => {
    const directory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    let failTempOpen = false;
    let current = new Date(ISO_1);
    const fs: LifetimeFileSystemOverrides = {
      open: async (path, flags, mode) => {
        if (failTempOpen && basename(String(path)).startsWith(TEMP_PREFIX)) {
          failTempOpen = false;
          throw Object.assign(new Error("injected temp rejection"), { code: "EIO" });
        }
        return base.open(path, flags, mode);
      },
    };
    const store = await openLifetimeStore({ directory, pid: 45, now: () => current, fs });
    assert.equal(await lockCreatedAt(directory), ISO_1);

    current = new Date(ISO_2);
    assert.equal((await store.checkpoint(root(0))).status, "committed");
    assert.equal(await lockCreatedAt(directory), ISO_2);

    current = new Date(ISO_3);
    failTempOpen = true;
    assert.deepEqual(await store.checkpoint(root(1, ISO_2)), {
      status: "notPublished",
      reason: "ioFailure",
    });
    assert.deepEqual(store.state(), { mode: "degraded", root: root(0), generation: 0 });
    assert.equal(await lockCreatedAt(directory), ISO_2);

    assert.equal((await store.checkpoint(root(1, ISO_2))).status, "committed");
    assert.deepEqual(store.state(), { mode: "writer", root: root(1, ISO_2), generation: 1 });
    assert.equal(await lockCreatedAt(directory), ISO_3);
    await store.close();
  });

  it("freezes writes after an indeterminate publication without refreshing the lease", async () => {
    const directory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    let current = new Date(ISO_1);
    let failAfterCommit = false;
    let primaryCommits = 0;
    const fs: LifetimeFileSystemOverrides = {
      rename: async (source, target) => {
        await base.rename(source, target);
        if (basename(String(source)).startsWith(TEMP_PREFIX) &&
            basename(String(target)) === PRIMARY) {
          primaryCommits++;
          if (failAfterCommit) {
            failAfterCommit = false;
            throw Object.assign(new Error("commit result lost"), { code: "EIO" });
          }
        }
      },
    };
    const store = await openLifetimeStore({ directory, pid: 46, now: () => current, fs });
    current = new Date(ISO_2);
    assert.equal((await store.checkpoint(root(0))).status, "committed");
    assert.equal(await lockCreatedAt(directory), ISO_2);

    current = new Date(ISO_3);
    failAfterCommit = true;
    const uncertain = store.checkpoint(root(1, ISO_2));
    const invalid = root(2, ISO_3);
    invalid.generation = -1;
    const queuedInvalid = store.checkpoint(invalid);
    assert.equal((await uncertain).status, "indeterminate");
    assert.deepEqual(store.state(), {
      mode: "recoveryRequired",
      root: root(0),
      generation: 0,
      reason: "indeterminatePublication",
    });
    assert.equal(await lockCreatedAt(directory), ISO_2);
    await assert.rejects(queuedInvalid, /recovery required/i);
    await assert.rejects(store.checkpoint(root(2, ISO_3)), /recovery required/i);
    assert.equal(primaryCommits, 2);
    await store.close();
  });

  it("loads and refreshes a secondary strictly upward without mutation or promotion", async () => {
    const directory = await temporaryDirectory();
    const writer = await openLifetimeStore({ directory, pid: 47 });
    assert.equal((await writer.checkpoint(root(0))).status, "committed");
    const secondary = await openLifetimeStore({
      directory,
      pid: 48,
      pidExists: () => true,
    });
    assert.deepEqual(secondary.state(), { mode: "readOnly", root: root(0), generation: 0 });
    assert.deepEqual(await secondary.refreshReadOnly(), { status: "unchanged" });

    assert.equal((await writer.checkpoint(root(1, ISO_2))).status, "committed");
    const before = await snapshotDirectory(directory);
    assert.deepEqual(await secondary.refreshReadOnly(), {
      status: "refreshed",
      root: root(1, ISO_2),
      generation: 1,
    });
    assert.deepEqual(secondary.state(), { mode: "readOnly", root: root(1, ISO_2), generation: 1 });
    assert.deepEqual(await snapshotDirectory(directory), before);
    assert.deepEqual(await secondary.refreshReadOnly(), { status: "unchanged" });

    await writer.close();
    await writeFile(join(directory, PRIMARY), JSON.stringify(root(0)));
    assert.deepEqual(await secondary.refreshReadOnly(), { status: "unchanged" });
    await unlink(join(directory, PRIMARY));
    assert.deepEqual(await secondary.refreshReadOnly(), { status: "unchanged" });
    assert.deepEqual(secondary.state(), { mode: "readOnly", root: root(1, ISO_2), generation: 1 });
    await assert.rejects(secondary.reset(root(2, ISO_3)), /read-only/i);
    assert.equal(await missing(join(directory, LIFETIME_LOCK_FILENAME)), true);
    await secondary.close();
  });

  it("retains a read-only root on transient load failure and fails closed on corruption", async () => {
    const directory = await temporaryDirectory();
    const writer = await openLifetimeStore({ directory, pid: 49 });
    assert.equal((await writer.checkpoint(root(0))).status, "committed");
    const base = resolveLifetimeFileSystem();
    let failureCode: "EIO" | "EMFILE" | null = null;
    const secondary = await openLifetimeStore({
      directory,
      pid: 50,
      pidExists: () => true,
      fs: {
        open: async (path, flags, mode) => {
          if (failureCode && String(path) === join(directory, PRIMARY)) {
            throw Object.assign(new Error("transient read failure"), { code: failureCode });
          }
          return base.open(path, flags, mode);
        },
      },
    });

    for (const code of ["EIO", "EMFILE"] as const) {
      failureCode = code;
      assert.deepEqual(await secondary.refreshReadOnly(), { status: "ioFailure" }, code);
      assert.deepEqual(secondary.state(), { mode: "readOnly", root: root(0), generation: 0 });
    }
    failureCode = null;
    await writeFile(join(directory, PRIMARY), "{\"schemaVersion\":1}");
    const before = await snapshotDirectory(directory);
    assert.deepEqual(await secondary.refreshReadOnly(), {
      status: "recoveryRequired",
      reason: "corruptCandidates",
    });
    assert.deepEqual(secondary.state(), {
      mode: "recoveryRequired",
      root: root(0),
      generation: 0,
      reason: "corruptCandidates",
    });
    assert.deepEqual(await snapshotDirectory(directory), before);

    await secondary.close();
    await writer.close();
  });

  it("reports unknown-schema recovery without mutating the read-only primary", async () => {
    const directory = await temporaryDirectory();
    const writer = await openLifetimeStore({ directory, pid: 65 });
    assert.equal((await writer.checkpoint(root(0))).status, "committed");
    const secondary = await openLifetimeStore({
      directory,
      pid: 66,
      pidExists: () => true,
    });
    await writeFile(
      join(directory, PRIMARY),
      JSON.stringify({ schemaVersion: 2, generation: 9, opaque: "future" }),
    );
    const before = await snapshotDirectory(directory);

    assert.deepEqual(await secondary.refreshReadOnly(), {
      status: "recoveryRequired",
      reason: "unknownSchema",
    });
    assert.deepEqual(secondary.state(), {
      mode: "recoveryRequired",
      root: root(0),
      generation: 0,
      reason: "unknownSchema",
    });
    assert.deepEqual(await snapshotDirectory(directory), before);
    await secondary.close();
    await writer.close();
  });

  it("classifies startup ready, io failure, and recovery-required states", async () => {
    const readyDirectory = await temporaryDirectory();
    assert.equal((await publishLifetimeGeneration(readyDirectory, root(3), 0)).status, "committed");
    const ready = await openLifetimeStore({ directory: readyDirectory, pid: 51 });
    assert.deepEqual(ready.state(), { mode: "writer", root: root(3), generation: 3 });
    await ready.close();

    const ioDirectory = await temporaryDirectory();
    await writeFile(join(ioDirectory, PRIMARY), JSON.stringify(root(0)));
    const base = resolveLifetimeFileSystem();
    const ioStore = await openLifetimeStore({
      directory: ioDirectory,
      pid: 52,
      fs: {
        open: async (path, flags, mode) => {
          if (String(path) === join(ioDirectory, PRIMARY)) {
            throw Object.assign(new Error("startup read failure"), { code: "EIO" });
          }
          return base.open(path, flags, mode);
        },
      },
    });
    assert.deepEqual(ioStore.state(), { mode: "degraded", root: null, generation: null });
    await ioStore.close();

    const readOnlyIoDirectory = await temporaryDirectory();
    const owner = await openLifetimeStore({ directory: readOnlyIoDirectory, pid: 58 });
    assert.equal((await owner.checkpoint(root(0))).status, "committed");
    const readOnlyIo = await openLifetimeStore({
      directory: readOnlyIoDirectory,
      pid: 59,
      pidExists: () => true,
      fs: {
        open: async (path, flags, mode) => {
          if (String(path) === join(readOnlyIoDirectory, PRIMARY)) {
            throw Object.assign(new Error("secondary startup read failure"), { code: "EIO" });
          }
          return base.open(path, flags, mode);
        },
      },
    });
    assert.deepEqual(readOnlyIo.state(), { mode: "readOnly", root: null, generation: null });
    await readOnlyIo.close();
    await owner.close();

    const corruptDirectory = await temporaryDirectory();
    await writeFile(join(corruptDirectory, PRIMARY), "{\"schemaVersion\":1}");
    const recovery = await openLifetimeStore({ directory: corruptDirectory, pid: 53 });
    assert.deepEqual(recovery.state(), {
      mode: "recoveryRequired",
      root: null,
      generation: null,
      reason: "corruptCandidates",
    });
    assert.deepEqual(Object.keys(recovery.state()), ["mode", "root", "generation", "reason"]);
    await assert.rejects(recovery.checkpoint(root(0)), /recovery required/i);
    await recovery.close();
  });

  it("publishes a final snapshot, releases once, and closes idempotently", async () => {
    const directory = await temporaryDirectory();
    const store = await openLifetimeStore({ directory, pid: 54 });
    const firstClose = store.close(root(0));
    const secondClose = store.close(root(9, ISO_3));
    assert.equal(firstClose, secondClose);
    await firstClose;
    const value: unknown = JSON.parse(await readFile(join(directory, PRIMARY), "utf8"));
    assert.equal(parseDurableLifetimeRoot(value).generation, 0);
    assert.equal(await missing(join(directory, LIFETIME_LOCK_FILENAME)), true);
    assert.throws(() => store.state(), /closed/i);
    await assert.rejects(store.checkpoint(root(1)), /closed/i);
    await assert.rejects(store.refreshReadOnly(), /closed/i);
  });

  it("rejects a definitely-not-published final checkpoint after releasing its lease", async () => {
    const directory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    let failFinalTemp = false;
    const store = await openLifetimeStore({
      directory,
      pid: 63,
      fs: {
        open: async (path, flags, mode) => {
          if (failFinalTemp && basename(String(path)).startsWith(TEMP_PREFIX)) {
            failFinalTemp = false;
            throw Object.assign(new Error("final checkpoint rejected"), { code: "EIO" });
          }
          return base.open(path, flags, mode);
        },
      },
    });
    failFinalTemp = true;

    await assert.rejects(
      store.close(root(0)),
      matchesCloseError({ status: "notPublished", reason: "ioFailure" }),
    );
    assert.equal(await missing(join(directory, PRIMARY)), true);
    assert.equal(await missing(join(directory, LIFETIME_LOCK_FILENAME)), true);
    await assert.rejects(store.checkpoint(root(0)), /closed/i);
  });

  it("rejects an indeterminate final checkpoint and preserves a replacement lease", async () => {
    const directory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const replacement = JSON.stringify({
      schemaVersion: 1,
      pid: 100,
      createdAt: ISO_3,
      nonce: "1234567890abcdef1234567890abcdef",
    });
    let replaced = false;
    const store = await openLifetimeStore({
      directory,
      pid: 64,
      fs: {
        rename: async (source, target) => {
          await base.rename(source, target);
          if (!replaced && basename(String(source)).startsWith(TEMP_PREFIX) &&
              basename(String(target)) === PRIMARY) {
            replaced = true;
            await unlink(lockPath);
            await writeFile(lockPath, replacement, { mode: 0o600 });
            throw Object.assign(new Error("final commit acknowledgement lost"), { code: "EIO" });
          }
        },
      },
    });

    await assert.rejects(
      store.close(root(0)),
      matchesCloseError({
        status: "indeterminate",
        reason: "publicationCommitUncertain",
        stage: "commit",
      }),
    );
    assert.equal(await readFile(lockPath, "utf8"), replacement);
    const value: unknown = JSON.parse(await readFile(join(directory, PRIMARY), "utf8"));
    assert.equal(parseDurableLifetimeRoot(value).generation, 0);
    await assert.rejects(store.checkpoint(root(1, ISO_2)), /closed/i);
  });

  it("degrades safely after lease replacement and preserves the new owner on close", async () => {
    const directory = await temporaryDirectory();
    const base = resolveLifetimeFileSystem();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const replacement = JSON.stringify({
      schemaVersion: 1,
      pid: 99,
      createdAt: ISO_2,
      nonce: "abcdefabcdefabcdefabcdefabcdefab",
    });
    let replaced = false;
    const store = await openLifetimeStore({
      directory,
      pid: 55,
      fs: {
        rename: async (source, target) => {
          await base.rename(source, target);
          if (!replaced && basename(String(source)).startsWith(TEMP_PREFIX) &&
              basename(String(target)) === PRIMARY) {
            replaced = true;
            await unlink(lockPath);
            await writeFile(lockPath, replacement, { mode: 0o600 });
          }
        },
      },
    });

    assert.equal((await store.checkpoint(root(0))).status, "committed");
    assert.deepEqual(store.state(), { mode: "degraded", root: root(0), generation: 0 });
    assert.deepEqual(await store.checkpoint(root(1, ISO_2)), {
      status: "notPublished",
      reason: "ioFailure",
    });
    const value: unknown = JSON.parse(await readFile(join(directory, PRIMARY), "utf8"));
    assert.equal(parseDurableLifetimeRoot(value).generation, 0);

    await store.close();
    assert.equal(await readFile(lockPath, "utf8"), replacement);
  });

  it("starts a read-only process in recovery without quarantining its primary", async () => {
    const directory = await temporaryDirectory();
    const lease = await acquireLifetimeLease(directory, { pid: 56 });
    assert.equal(lease.mode, "writer");
    if (lease.mode !== "writer") return;
    await writeFile(join(directory, PRIMARY), "{\"schemaVersion\":1}");
    const before = await snapshotDirectory(directory);

    const secondary = await openLifetimeStore({
      directory,
      pid: 57,
      pidExists: () => true,
    });
    assert.deepEqual(secondary.state(), {
      mode: "recoveryRequired",
      root: null,
      generation: null,
      reason: "corruptCandidates",
    });
    assert.deepEqual(await snapshotDirectory(directory), before);
    await secondary.close();
    assert.deepEqual(await snapshotDirectory(directory), before);
    await releaseLifetimeLease(lease.lease);
  });
});
