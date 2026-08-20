import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, it } from "node:test";

import {
  LIFETIME_CLAIM_FILENAME,
  type LifetimeEvidenceLabel,
  rotateLifetimeEvidence,
} from "../../../dist/observability/lifetime-evidence.js";
import {
  LIFETIME_LOCK_FILENAME,
  acquireLifetimeLease,
  refreshLifetimeLease,
  releaseLifetimeLease,
  type LifetimeWriterLease,
} from "../../../dist/observability/lifetime-lock.js";

const ISO_1 = "2026-08-20T01:02:03.004Z";
const ISO_2 = "2026-08-20T01:03:04.005Z";
const temporaryDirectories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sdl-lifetime-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function lockRecord(
  pid: number,
  nonce = "0123456789abcdef0123456789abcdef",
  createdAt = ISO_1,
): string {
  return JSON.stringify({ schemaVersion: 1, pid, createdAt, nonce });
}

function createAnchorRecord(
  claimantPid: number,
  nonce: string,
  lockPid = claimantPid,
  createdAt = ISO_1,
  lockCreatedAt = createdAt,
): string {
  const lock = { schemaVersion: 1, pid: lockPid, createdAt: lockCreatedAt, nonce };
  return JSON.stringify({
    schemaVersion: 1,
    pid: claimantPid,
    createdAt,
    nonce,
    lock,
    lockSha256: createHash("sha256").update(JSON.stringify(lock)).digest("hex"),
  });
}

async function fileSnapshot(path: string) {
  const content = await readFile(path);
  const stat = await lstat(path);
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function claimRecord(
  pid: number,
  nonce: string,
  source: Awaited<ReturnType<typeof fileSnapshot>>,
  createdAt = ISO_1,
): string {
  return JSON.stringify({ schemaVersion: 1, pid, createdAt, nonce, source });
}

function assertWriter(
  result: Awaited<ReturnType<typeof acquireLifetimeLease>>,
): asserts result is { mode: "writer"; lease: LifetimeWriterLease } {
  assert.equal(result.mode, "writer");
}

async function evidenceFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => name.startsWith("sdl-observability-lifetime.evidence."))
    .sort();
}

async function auxiliaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => name.startsWith(".sdl-observability-lifetime.") ||
      name === LIFETIME_CLAIM_FILENAME)
    .sort();
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function spawnWorker(directory: string, extraArguments: readonly string[] = []) {
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "tests/fixtures/observability-lifetime-lock-worker.mjs"),
      directory,
      ...extraArguments,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.add(child);
  const lines = createInterface({ input: child.stdout });
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const next = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const queued = queue.shift();
    if (queued) {
      resolve(queued);
      return;
    }
    waiters.push(resolve);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`lock worker exited ${code}: ${child.stderr.read() ?? ""}`));
      }
    });
  });
  const send = (command: "state" | "release" | "exit") => child.stdin.write(`${command}\n`);
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      children.delete(child);
      lines.close();
      if (code === 0 || child.killed) resolve();
      else reject(new Error(`lock worker exited ${code}: ${child.stderr.read() ?? ""}`));
    });
  });
  return { child, next, send, exited };
}

async function crashClaimWorker(
  directory: string,
  sourcePath: string,
  phase: "claim-before-move" | "claim-after-move",
): Promise<void> {
  const worker = await spawnWorker(directory, [phase, sourcePath]);
  assert.deepEqual(await worker.next(), {
    event: "claim-held",
    phase: phase === "claim-before-move" ? "before-move" : "after-move",
  });
  worker.child.kill();
  await worker.exited;
}

afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.allSettled([...children].map((child) => new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  })));
  children.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("lifetime persistence lock", () => {
  it("exclusively creates a closed, synced writer record with bounded identity", async () => {
    const directory = await temporaryDirectory();
    const result = await acquireLifetimeLease(directory, {
      now: () => new Date(ISO_1),
      pid: 4242,
      randomBytes: () => Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    });
    assertWriter(result);

    assert.equal(basename(result.lease.lockPath), LIFETIME_LOCK_FILENAME);
    const raw = await readFile(result.lease.lockPath, "utf8");
    const record = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), ["schemaVersion", "pid", "createdAt", "nonce"]);
    assert.deepEqual(record, {
      schemaVersion: 1,
      pid: 4242,
      createdAt: ISO_1,
      nonce: "00112233445566778899aabbccddeeff",
    });
    assert.match(String(record.nonce), /^[0-9a-f]{32}$/);
    assert.equal(new Date(String(record.createdAt)).toISOString(), record.createdAt);

    if (process.platform !== "win32") {
      assert.equal((await lstat(result.lease.lockPath)).mode & 0o777, 0o600);
    }
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("removes its exact created lock after write, sync, or validation failure", async () => {
    for (const stage of [
      "write",
      "sync",
      "close",
      "validation-read",
      "validation-mismatch",
    ] as const) {
      const directory = await temporaryDirectory();
      const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
      let validationIntercepted = false;
      const result = await acquireLifetimeLease(directory, {
        randomBytes: () => Buffer.alloc(16, stage.length),
        fileSystem: {
          open: async (...args: Parameters<typeof open>) => {
            if (
              args[0] === lockPath &&
              typeof args[1] === "number" &&
              !validationIntercepted
            ) {
              validationIntercepted = true;
              if (stage === "validation-read") {
                throw Object.assign(new Error("validation read failed"), { code: "EIO" });
              }
              if (stage === "validation-mismatch") {
                await writeFile(lockPath, lockRecord(9191, "9".repeat(32)), "utf8");
              }
            }
            const handle = await open(...args);
            if (args[0] !== lockPath || args[1] !== "wx") return handle;
            return new Proxy(handle, {
              get(target, property) {
                if (property === "writeFile" && stage === "write") {
                  return async () => {
                    await target.writeFile("partial", "utf8");
                    throw Object.assign(new Error("lock write failed"), { code: "EIO" });
                  };
                }
                if (property === "sync" && stage === "sync") {
                  return async () => {
                    throw Object.assign(new Error("lock sync failed"), { code: "EIO" });
                  };
                }
                if (property === "close" && stage === "close") {
                  return async () => {
                    await target.close();
                    throw Object.assign(new Error("lock close failed"), { code: "EIO" });
                  };
                }
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        },
      });

      assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" }, stage);
      await assertMissing(lockPath);
      assert.deepEqual(await auxiliaryFiles(directory), [], stage);
    }
  });

  it("cleans its exact create anchor and resolves read-only for anchor I/O failures", async () => {
    for (const stage of ["write", "sync", "close", "validation-read"] as const) {
      const directory = await temporaryDirectory();
      let validationIntercepted = false;
      const result = await acquireLifetimeLease(directory, {
        randomBytes: () => Buffer.alloc(16, stage.length + 10),
        fileSystem: {
          open: async (...args: Parameters<typeof open>) => {
            const isAnchor = basename(String(args[0])).startsWith(
              ".sdl-observability-lifetime.create.",
            );
            if (isAnchor && typeof args[1] === "number" && !validationIntercepted) {
              validationIntercepted = true;
              if (stage === "validation-read") {
                throw Object.assign(new Error("anchor validation failed"), { code: "EIO" });
              }
            }
            const handle = await open(...args);
            if (!isAnchor || args[1] !== "wx") return handle;
            return new Proxy(handle, {
              get(target, property) {
                if (property === "writeFile" && stage === "write") {
                  return async () => {
                    await target.writeFile("partial", "utf8");
                    throw Object.assign(new Error("anchor write failed"), { code: "EIO" });
                  };
                }
                if (property === "sync" && stage === "sync") {
                  return async () => {
                    throw Object.assign(new Error("anchor sync failed"), { code: "EIO" });
                  };
                }
                if (property === "close" && stage === "close") {
                  return async () => {
                    await target.close();
                    throw Object.assign(new Error("anchor close failed"), { code: "EIO" });
                  };
                }
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        },
      });

      assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" }, stage);
      await assertMissing(join(directory, LIFETIME_LOCK_FILENAME));
      assert.deepEqual(await auxiliaryFiles(directory), [], stage);
    }
  });

  it("refreshes only the current owner after a successful checkpoint", async () => {
    const directory = await temporaryDirectory();
    const result = await acquireLifetimeLease(directory, {
      now: () => new Date(ISO_1),
      pid: 4242,
    });
    assertWriter(result);
    const wrongLease = { ...result.lease, nonce: "f".repeat(32) };
    assert.equal(await refreshLifetimeLease(wrongLease, {
      now: () => new Date(ISO_2),
    }), false);
    assert.equal(JSON.parse(await readFile(result.lease.lockPath, "utf8")).createdAt, ISO_1);

    assert.equal(await refreshLifetimeLease(result.lease, {
      now: () => new Date(ISO_2),
    }), true);
    const refreshed = JSON.parse(await readFile(result.lease.lockPath, "utf8"));
    assert.deepEqual(Object.keys(refreshed), ["schemaVersion", "pid", "createdAt", "nonce"]);
    assert.deepEqual(refreshed, {
      schemaVersion: 1,
      pid: 4242,
      createdAt: ISO_2,
      nonce: result.lease.nonce,
    });
  });

  it("releases only a matching owner and preserves a replaced lock", async () => {
    const directory = await temporaryDirectory();
    const result = await acquireLifetimeLease(directory, { pid: 4242 });
    assertWriter(result);

    const wrongLease = { ...result.lease, nonce: "f".repeat(32) };
    assert.equal(await releaseLifetimeLease(wrongLease), false);
    assert.equal((await lstat(result.lease.lockPath)).isFile(), true);

    const replacement = lockRecord(4343, "a".repeat(32), ISO_2);
    await writeFile(result.lease.lockPath, replacement, "utf8");
    assert.equal(await releaseLifetimeLease(result.lease), false);
    assert.equal(await readFile(result.lease.lockPath, "utf8"), replacement);
  });

  it("rotates a dead owner's lock and retries exclusive creation exactly once", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    let exclusiveCreates = 0;

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          if (args[0] === lockPath && args[1] === "wx") exclusiveCreates++;
          return open(...args);
        },
      },
    });
    assertWriter(result);
    assert.equal(exclusiveCreates, 2);
    const evidence = await evidenceFiles(directory);
    assert.equal(evidence.length, 1);
    assert.equal(JSON.parse(await readFile(join(directory, evidence[0]), "utf8")).pid, 999_999);
  });

  it("returns read-only after the one stale-lock retry contends", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    let exclusiveCreates = 0;
    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          if (args[0] === lockPath && args[1] === "wx") {
            exclusiveCreates++;
            if (exclusiveCreates === 2) {
              throw Object.assign(new Error("retry contended"), { code: "EEXIST" });
            }
            if (exclusiveCreates > 2) throw new Error("unexpected third exclusive create");
          }
          return open(...args);
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "contended" });
    assert.equal(exclusiveCreates, 2);
    assert.equal((await evidenceFiles(directory)).length, 1);
  });

  it("prevents a delayed stale reclaimer from moving a newly acquired live lock", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    const delayed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let delayedOnce = false;
    let claimAttempted = false;
    const delayedFileSystem = {
      link: async (source: string, target: string) => {
        if (source === lockPath && !delayedOnce) {
          delayedOnce = true;
          claimAttempted = true;
          delayed.resolve();
          await resume.promise;
        }
        return link(source, target);
      },
      rename: async (source: string, target: string) => {
        if (source === lockPath && !claimAttempted && !delayedOnce) {
          delayedOnce = true;
          delayed.resolve();
          await resume.promise;
        }
        return rename(source, target);
      },
    };

    const lateResultPromise = acquireLifetimeLease(directory, {
      pid: 4343,
      isPidAlive: () => false,
      randomBytes: () => Buffer.alloc(16, 0xbb),
      fileSystem: delayedFileSystem,
    });
    await delayed.promise;
    const competingResult = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      randomBytes: () => Buffer.alloc(16, 0xaa),
    });
    resume.resolve();
    const lateResult = await lateResultPromise;
    assert.equal(
      [competingResult, lateResult].filter((result) => result.mode === "writer").length,
      1,
    );
    const winner = competingResult.mode === "writer" ? competingResult : lateResult;
    assertWriter(winner);
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), {
      schemaVersion: 1,
      pid: winner.lease.pid,
      createdAt: winner.lease.createdAt,
      nonce: winner.lease.nonce,
    });
    assert.equal(await releaseLifetimeLease(winner.lease), true);
  });

  it("recovers a proven-dead crashed claim while its source still exists", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
    });
    assertWriter(result);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("recovers a proven-dead crashed claim after its source moved", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-after-move");
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isClaimantPidAlive: () => false,
    });
    assertWriter(result);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("keeps a live claimant authoritative", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    const worker = await spawnWorker(directory, ["claim-before-move", lockPath]);
    assert.deepEqual(await worker.next(), { event: "claim-held", phase: "before-move" });

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: (pid) => pid === worker.child.pid,
    });
    assert.equal(result.mode, "readOnly");
    assert.equal((await lstat(lockPath)).isFile(), true);
    worker.child.kill();
    await worker.exited;
  });

  it("recovers dead create auxiliaries stranded before the fixed claim link", async () => {
    const directory = await temporaryDirectory();
    const worker = await spawnWorker(directory, ["create-before-fixed"]);
    assert.deepEqual(await worker.next(), { event: "create-held", phase: "before-fixed" });
    worker.child.kill();
    await worker.exited;
    assert.ok((await auxiliaryFiles(directory)).length >= 2);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(result);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("recovers dead claim auxiliaries stranded after the fixed claim is removed", async () => {
    const directory = await temporaryDirectory();
    const worker = await spawnWorker(directory, ["release-after-fixed-removal"]);
    assert.deepEqual(await worker.next(), {
      event: "release-held",
      phase: "after-fixed-removal",
    });
    worker.child.kill();
    await worker.exited;
    await assertMissing(join(directory, LIFETIME_CLAIM_FILENAME));
    assert.ok((await auxiliaryFiles(directory)).length >= 2);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(result);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("recovers a dead release candidate with its exact claim metadata", async () => {
    const directory = await temporaryDirectory();
    const worker = await spawnWorker(directory, ["release-after-lock-move"]);
    assert.deepEqual(await worker.next(), {
      event: "release-held",
      phase: "after-lock-move",
    });
    worker.child.kill();
    await worker.exited;
    await assertMissing(join(directory, LIFETIME_LOCK_FILENAME));
    assert.ok((await auxiliaryFiles(directory)).some((name) => name.includes(".release.")));

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(result);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("preserves live, malformed, and unknown startup auxiliaries fail-closed", async () => {
    const liveDirectory = await temporaryDirectory();
    const worker = await spawnWorker(liveDirectory, ["create-before-fixed"]);
    assert.deepEqual(await worker.next(), { event: "create-held", phase: "before-fixed" });
    const liveBefore = await auxiliaryFiles(liveDirectory);
    const live = await acquireLifetimeLease(liveDirectory, {
      isClaimantPidAlive: (pid) => pid === worker.child.pid,
    });
    assert.equal(live.mode, "readOnly");
    assert.deepEqual(await auxiliaryFiles(liveDirectory), liveBefore);

    for (const name of [
      `.sdl-observability-lifetime.create.${"a".repeat(32)}`,
      `.sdl-observability-lifetime.future.${"b".repeat(32)}`,
    ]) {
      const directory = await temporaryDirectory();
      const path = join(directory, name);
      await writeFile(path, "malformed or unknown", { mode: 0o600 });
      const result = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      assert.equal(result.mode, "readOnly", name);
      assert.equal(await readFile(path, "utf8"), "malformed or unknown");
    }
    worker.child.kill();
    await worker.exited;
  });

  it("drains proven-dead startup auxiliaries in bounded batches", async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 33; index++) {
      const nonce = index.toString(16).padStart(32, "0");
      await writeFile(
        join(directory, `.sdl-observability-lifetime.create.${nonce}`),
        createAnchorRecord(999_999, nonce),
        { mode: 0o600 },
      );
    }
    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(result.mode, "readOnly");
    assert.equal((await auxiliaryFiles(directory)).length, 1);

    const successor = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
  });

  it("applies the cleanup budget to complete claim dependency groups", async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 32; index++) {
      const nonce = index.toString(16).padStart(32, "0");
      const source = join(directory, `group-source-${index}.json`);
      await writeFile(source, lockRecord(90_000 + index));
      const snapshot = await fileSnapshot(source);
      const createdAt = new Date(Date.parse(ISO_1) + index).toISOString();
      await writeFile(
        join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
        claimRecord(999_999, nonce, snapshot, createdAt),
      );
      await link(source, join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`));
    }

    const first = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(first.mode, "readOnly");
    for (let index = 0; index < 32; index++) {
      const nonce = index.toString(16).padStart(32, "0");
      const record = join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`);
      const witness = join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`);
      if (index < 16) {
        await assertMissing(record);
        await assertMissing(witness);
      } else {
        assert.equal((await lstat(record)).isFile(), true);
        assert.equal((await lstat(witness)).isFile(), true);
      }
    }

    const second = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(second);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal(await releaseLifetimeLease(second.lease), true);
  });

  it("preserves one dependency group larger than the cleanup budget", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "oversized-group-source.json");
    await writeFile(source, lockRecord(91_000));
    const snapshot = await fileSnapshot(source);
    for (let index = 0; index < 17; index++) {
      const nonce = (index + 100).toString(16).padStart(32, "0");
      await writeFile(
        join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
        claimRecord(999_999, nonce, snapshot),
      );
      await link(source, join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`));
    }
    const before = await auxiliaryFiles(directory);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(result.mode, "readOnly");
    assert.deepEqual(await auxiliaryFiles(directory), before);
  });

  it("preserves create-lock candidates whose bound metadata disagrees", async () => {
    for (const mismatch of ["pid", "timestamp", "nonce", "live-candidate"] as const) {
      const directory = await temporaryDirectory();
      const nonce = "a".repeat(32);
      const candidateNonce = mismatch === "nonce" ? "b".repeat(32) : nonce;
      const candidatePid = mismatch === "pid" ? 888_888
        : mismatch === "live-candidate" ? process.pid
          : 999_999;
      const expectedLockPid = mismatch === "live-candidate" ? process.pid : 999_999;
      const candidateTime = mismatch === "timestamp" ? ISO_2 : ISO_1;
      await writeFile(
        join(directory, `.sdl-observability-lifetime.create.${nonce}`),
        createAnchorRecord(999_999, nonce, expectedLockPid, ISO_1, ISO_1),
      );
      await writeFile(
        join(directory, `.sdl-observability-lifetime.create-lock.${nonce}`),
        lockRecord(candidatePid, candidateNonce, candidateTime),
      );
      const before = await auxiliaryFiles(directory);

      const result = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: (pid) => mismatch === "live-candidate" && pid === process.pid,
      });
      assert.equal(result.mode, "readOnly", mismatch);
      assert.deepEqual(await auxiliaryFiles(directory), before, mismatch);
    }
  });

  it("preserves claim artifacts whose filename nonce disagrees with content", async () => {
    for (const kind of ["cleanup", "recovery-witness", "recovery-moved"] as const) {
      const directory = await temporaryDirectory();
      const source = join(directory, `${kind}-source.json`);
      await writeFile(source, lockRecord(92_000));
      const embeddedNonce = "c".repeat(32);
      const filenameNonce = "d".repeat(32);
      const path = join(
        directory,
        `.sdl-observability-lifetime.claim-${kind}.${filenameNonce}`,
      );
      await writeFile(path, claimRecord(999_999, embeddedNonce, await fileSnapshot(source)));

      const result = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      assert.equal(result.mode, "readOnly", kind);
      assert.equal((await lstat(path)).isFile(), true, kind);
    }
  });

  it("preserves a claim artifact without its paired durable record", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "standalone-cleanup-source.json");
    await writeFile(source, lockRecord(93_000));
    const nonce = "e".repeat(32);
    const path = join(directory, `.sdl-observability-lifetime.claim-cleanup.${nonce}`);
    await writeFile(path, claimRecord(999_999, nonce, await fileSnapshot(source)));

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(result.mode, "readOnly");
    assert.equal((await lstat(path)).isFile(), true);
  });

  it("preserves malformed or identity-mismatched claim metadata", async () => {
    const malformedDirectory = await temporaryDirectory();
    const malformedClaim = join(malformedDirectory, "sdl-observability-lifetime.claim");
    await writeFile(malformedClaim, "not closed claim metadata", { mode: 0o600 });
    const malformed = await acquireLifetimeLease(malformedDirectory, { pid: 4242 });
    assert.equal(malformed.mode, "readOnly");
    assert.equal(await readFile(malformedClaim, "utf8"), "not closed claim metadata");

    const mismatchDirectory = await temporaryDirectory();
    const lockPath = join(mismatchDirectory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(mismatchDirectory, lockPath, "claim-before-move");
    const claimFiles = (await readdir(mismatchDirectory))
      .filter((name) => name.startsWith(".sdl-observability-lifetime.claim-record."));
    assert.equal(claimFiles.length, 1);
    const recordPath = join(mismatchDirectory, claimFiles[0]);
    const replacementPath = join(mismatchDirectory, "claim-record-replacement.json");
    await writeFile(replacementPath, await readFile(recordPath), { mode: 0o600 });
    await rename(replacementPath, recordPath);
    const fixedClaimBefore = await readFile(
      join(mismatchDirectory, "sdl-observability-lifetime.claim"),
      "utf8",
    );

    const mismatch = await acquireLifetimeLease(mismatchDirectory, {
      pid: 4242,
      isClaimantPidAlive: () => false,
    });
    assert.equal(mismatch.mode, "readOnly");
    assert.equal(
      await readFile(join(mismatchDirectory, "sdl-observability-lifetime.claim"), "utf8"),
      fixedClaimBefore,
    );
  });

  it("allows only one of two concurrent dead-claim recoverers to acquire", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");

    const [left, right] = await Promise.all([
      acquireLifetimeLease(directory, {
        pid: 4242,
        isPidAlive: () => false,
        isClaimantPidAlive: () => false,
        randomBytes: () => Buffer.alloc(16, 0x11),
      }),
      acquireLifetimeLease(directory, {
        pid: 4343,
        isPidAlive: () => false,
        isClaimantPidAlive: () => false,
        randomBytes: () => Buffer.alloc(16, 0x22),
      }),
    ]);
    assert.equal([left, right].filter((result) => result.mode === "writer").length, 1);
    const writer = left.mode === "writer" ? left : right;
    assertWriter(writer);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, writer.lease.nonce);
    assert.equal(await releaseLifetimeLease(writer.lease), true);
  });

  it("serializes a creator that passed startup checks against stale reclamation", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    const creatorReady = Promise.withResolvers<void>();
    const resumeCreator = Promise.withResolvers<void>();
    const creatorSawClaim = Promise.withResolvers<void>();
    const reclaimerCheckedAuxiliaries = Promise.withResolvers<void>();
    let creatorPaused = false;

    const creatorPromise = acquireLifetimeLease(directory, {
      pid: 4242,
      randomBytes: () => Buffer.alloc(16, 0xaa),
      fileSystem: {
        link: async (source: string, target: string) => {
          if (
            basename(source).startsWith(".sdl-observability-lifetime.create.") ||
            basename(target) === "sdl-observability-lifetime.claim"
          ) {
            if (!creatorPaused) {
              creatorPaused = true;
              creatorReady.resolve();
              await resumeCreator.promise;
            }
            try {
              return await link(source, target);
            } finally {
              creatorSawClaim.resolve();
            }
          }
          return link(source, target);
        },
        lstat: async (path: string) => {
          const result = await lstat(path);
          if (
            path === join(directory, "sdl-observability-lifetime.claim") &&
            creatorPaused
          ) {
            creatorSawClaim.resolve();
          }
          return result;
        },
        open: async (...args: Parameters<typeof open>) => {
          if (args[0] === lockPath && args[1] === "wx" && !creatorPaused) {
            creatorPaused = true;
            creatorReady.resolve();
            await resumeCreator.promise;
          }
          return open(...args);
        },
      },
    });
    await creatorReady.promise;
    const reclaimerPromise = acquireLifetimeLease(directory, {
      pid: 4343,
      isPidAlive: () => false,
      randomBytes: () => Buffer.alloc(16, 0xbb),
      fileSystem: {
        readdir: async (...args: Parameters<typeof readdir>) => {
          const result = await readdir(...args);
          reclaimerCheckedAuxiliaries.resolve();
          return result;
        },
      },
    });
    await reclaimerCheckedAuxiliaries.promise;
    const reclaimer = await reclaimerPromise;
    assert.equal(reclaimer.mode, "readOnly");
    resumeCreator.resolve();
    await creatorSawClaim.promise;
    const creator = await creatorPromise;
    assert.equal(
      [creator, reclaimer].filter((result) => result.mode === "writer").length,
      1,
      JSON.stringify({ creator, reclaimer }),
    );
    const writer = creator.mode === "writer" ? creator : reclaimer;
    assertWriter(writer);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, writer.lease.nonce);
    assert.equal(await releaseLifetimeLease(writer.lease), true);
  });

  it("treats a reused live PID as authoritative without evidence", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, LIFETIME_LOCK_FILENAME), lockRecord(4242));
    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => true,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "contended" });
    assert.deepEqual(await evidenceFiles(directory), []);
  });

  it("treats only ESRCH as dead and fails closed for EPERM or unknown PID errors", async () => {
    for (const [code, expectedMode] of [
      ["ESRCH", "writer"],
      ["EPERM", "readOnly"],
      ["EUNKNOWN", "readOnly"],
    ] as const) {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, LIFETIME_LOCK_FILENAME), lockRecord(777_777));
      const result = await acquireLifetimeLease(directory, {
        pid: 4242,
        signalPid: () => {
          throw Object.assign(new Error(code), { code });
        },
      });
      assert.equal(result.mode, expectedMode, code);
      if (result.mode === "writer") assert.equal(await releaseLifetimeLease(result.lease), true);
      else assert.deepEqual(await evidenceFiles(directory), []);
    }
  });

  it("caps shared lock/publication evidence at eight and protects unknown-newer evidence", async () => {
    const directory = await temporaryDirectory();
    const supported: LifetimeEvidenceLabel = {
      kind: "lock",
      eligibility: "validated-supported",
    };
    const protectedPublication: LifetimeEvidenceLabel = {
      kind: "publication",
      eligibility: "protected-unknown-newer",
    };
    const paths: string[] = [];
    for (let index = 0; index < 8; index++) {
      const source = join(directory, `source-${index}.json`);
      await writeFile(source, lockRecord(10_000 + index));
      paths.push(await rotateLifetimeEvidence(
        directory,
        source,
        index === 0 ? protectedPublication : supported,
        {
          now: () => new Date(1_700_000_000_000 + index),
          randomBytes: () => Buffer.alloc(16, index),
        },
      ));
    }
    const ninthSource = join(directory, "source-8.json");
    await writeFile(ninthSource, lockRecord(10_008));
    paths.push(await rotateLifetimeEvidence(
      directory,
      ninthSource,
      { kind: "publication", eligibility: "validated-supported" },
      {
        now: () => new Date(1_700_000_000_008),
        randomBytes: () => Buffer.alloc(16, 8),
      },
    ));

    assert.equal((await evidenceFiles(directory)).length, 8);
    assert.equal((await lstat(paths[0])).isFile(), true, "unknown-newer evidence is preserved");
    await assert.rejects(lstat(paths[1]), { code: "ENOENT" });
  });

  it("serializes concurrent lock/publication evidence rotation at the shared cap", async () => {
    const directory = await temporaryDirectory();
    const paths: string[] = [];
    for (let index = 0; index < 7; index++) {
      const source = join(directory, `seed-${index}.json`);
      await writeFile(source, lockRecord(40_000 + index));
      paths.push(await rotateLifetimeEvidence(
        directory,
        source,
        {
          kind: index === 0 ? "publication" : "lock",
          eligibility: index === 0
            ? "protected-unknown-newer"
            : "validated-supported",
        },
        {
          now: () => new Date(1_700_000_002_000 + index),
          randomBytes: () => Buffer.alloc(16, index),
        },
      ));
    }
    const sourceA = join(directory, "rotation-a.json");
    const sourceB = join(directory, "rotation-b.json");
    await writeFile(sourceA, lockRecord(50_001));
    await writeFile(sourceB, lockRecord(50_002));
    const aRenameReady = Promise.withResolvers<void>();
    const secondAttempt = Promise.withResolvers<void>();

    const rotationA = rotateLifetimeEvidence(
      directory,
      sourceA,
      { kind: "lock", eligibility: "validated-supported" },
      {
        now: () => new Date(1_700_000_003_000),
        randomBytes: () => Buffer.alloc(16, 0xaa),
        fileSystem: {
          link,
          rename: async (source: string, target: string) => {
            if (source === sourceA) {
              aRenameReady.resolve();
              await secondAttempt.promise;
            }
            return rename(source, target);
          },
        },
      },
    );
    await aRenameReady.promise;
    const rotationB = rotateLifetimeEvidence(
      directory,
      sourceB,
      { kind: "publication", eligibility: "validated-supported" },
      {
        now: () => new Date(1_700_000_003_001),
        randomBytes: () => Buffer.alloc(16, 0xbb),
        fileSystem: {
          link: async (source: string, target: string) => {
            secondAttempt.resolve();
            return link(source, target);
          },
          rename: async (source: string, target: string) => {
            secondAttempt.resolve();
            return rename(source, target);
          },
        },
      },
    );
    await Promise.all([rotationA, rotationB]);

    assert.equal((await evidenceFiles(directory)).length, 8);
    assert.equal((await lstat(paths[0])).isFile(), true, "protected evidence remains");
    await assert.rejects(lstat(paths[1]), { code: "ENOENT" });
  });

  it("restores a stranded evidence-eviction candidate before acquiring", async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 8; index++) {
      const source = join(directory, `eviction-seed-${index}.json`);
      await writeFile(source, lockRecord(70_000 + index));
      await rotateLifetimeEvidence(
        directory,
        source,
        { kind: "lock", eligibility: "validated-supported" },
        {
          now: () => new Date(1_700_000_004_000 + index),
          randomBytes: () => Buffer.alloc(16, index),
        },
      );
    }
    const source = join(directory, "eviction-interrupted.json");
    await writeFile(source, lockRecord(80_000));
    let interrupted = false;
    await assert.rejects(
      rotateLifetimeEvidence(
        directory,
        source,
        { kind: "publication", eligibility: "validated-supported" },
        {
          randomBytes: () => Buffer.alloc(16, 0xcc),
          fileSystem: {
            rename: async (from: string, to: string) => {
              const result = await rename(from, to);
              if (!interrupted && basename(to).startsWith(
                ".sdl-observability-lifetime.delete.",
              )) {
                interrupted = true;
                throw Object.assign(new Error("eviction interrupted"), { code: "EIO" });
              }
              return result;
            },
          },
        },
      ),
      /interrupted/,
    );
    assert.equal(interrupted, true);
    assert.equal((await auxiliaryFiles(directory)).length, 1);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(result);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal((await evidenceFiles(directory)).length, 8);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("retains recoverable claim metadata when exact claim cleanup is blocked", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "cleanup-collision-source.json");
    const nonce = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
    );
    await writeFile(source, lockRecord(60_000));
    await writeFile(cleanupPath, "operator-owned collision");

    await rotateLifetimeEvidence(
      directory,
      source,
      { kind: "lock", eligibility: "validated-supported" },
      { randomBytes: () => Buffer.from(nonce, "hex") },
    );

    const fixed = await readFile(join(directory, LIFETIME_CLAIM_FILENAME), "utf8");
    const record = await readFile(
      join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
      "utf8",
    );
    assert.equal(record, fixed, "a residual fixed claim retains its durable record");
    assert.equal(await readFile(cleanupPath, "utf8"), "operator-owned collision");
  });

  it("fails closed when the filesystem cannot hard-link an evidence claim", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "unsupported-link.json");
    await writeFile(source, lockRecord(60_001));
    await assert.rejects(
      rotateLifetimeEvidence(
        directory,
        source,
        { kind: "lock", eligibility: "validated-supported" },
        {
          fileSystem: {
            link: async () => {
              throw Object.assign(new Error("hard links unavailable"), { code: "EPERM" });
            },
          },
        },
      ),
      /claim|hard link/i,
    );
    assert.equal((await lstat(source)).isFile(), true);
  });

  it("fails closed when only protected evidence can make room", async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 8; index++) {
      const source = join(directory, `protected-source-${index}.json`);
      await writeFile(source, lockRecord(20_000 + index));
      await rotateLifetimeEvidence(
        directory,
        source,
        { kind: "publication", eligibility: "protected-unknown-newer" },
        {
          now: () => new Date(1_700_000_001_000 + index),
          randomBytes: () => Buffer.alloc(16, index),
        },
      );
    }
    const source = join(directory, "ninth-protected.json");
    await writeFile(source, lockRecord(30_000));
    await assert.rejects(
      rotateLifetimeEvidence(
        directory,
        source,
        { kind: "lock", eligibility: "validated-supported" },
      ),
      /eligible evidence/i,
    );
    assert.equal((await lstat(source)).isFile(), true);
    assert.equal((await evidenceFiles(directory)).length, 8);
  });

  it("refuses malformed, oversized, and non-regular lock paths", async () => {
    for (const setup of [
      async (path: string) => writeFile(path, "not json"),
      async (path: string) => writeFile(path, "x".repeat(8_193)),
      async (path: string) => mkdir(path),
    ]) {
      const directory = await temporaryDirectory();
      await setup(join(directory, LIFETIME_LOCK_FILENAME));
      const result = await acquireLifetimeLease(directory);
      assert.equal(result.mode, "readOnly");
    }
  });

  it("refuses symlink lock and evidence paths when the platform supports symlinks", async (t) => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    await writeFile(target, lockRecord(4242));
    try {
      await symlink(target, join(directory, LIFETIME_LOCK_FILENAME), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlinks require privileges on this platform");
        return;
      }
      throw error;
    }
    const result = await acquireLifetimeLease(directory);
    assert.equal(result.mode, "readOnly");

    await rm(join(directory, LIFETIME_LOCK_FILENAME));
    const evidenceSource = join(directory, "evidence-source.json");
    await writeFile(evidenceSource, lockRecord(4343));
    const evidenceLink = join(
      directory,
      "sdl-observability-lifetime.evidence.v1.validated-supported.lock.1700000000000.00112233445566778899aabbccddeeff.json",
    );
    await symlink(target, evidenceLink, "file");
    await assert.rejects(
      rotateLifetimeEvidence(directory, evidenceSource, {
        kind: "lock",
        eligibility: "validated-supported",
      }),
      /regular non-symlink/i,
    );
    assert.equal((await lstat(evidenceSource)).isFile(), true);

    await rm(evidenceLink);
    const evidenceDirectory = join(
      directory,
      "sdl-observability-lifetime.evidence.v1.validated-supported.lock.000loyw3v28.11112233445566778899aabbccddeeff.json",
    );
    await mkdir(evidenceDirectory);
    await assert.rejects(
      rotateLifetimeEvidence(directory, evidenceSource, {
        kind: "lock",
        eligibility: "validated-supported",
      }),
      /regular non-symlink/i,
    );
    assert.equal((await lstat(evidenceSource)).isFile(), true);
  });

  it("preserves a replacement raced into the lock path during release", async () => {
    const directory = await temporaryDirectory();
    const result = await acquireLifetimeLease(directory, { pid: 4242 });
    assertWriter(result);
    const replacementPath = join(directory, "release-replacement.json");
    const replacement = lockRecord(4343, "c".repeat(32), ISO_2);
    await writeFile(replacementPath, replacement, { mode: 0o600 });
    let replaced = false;
    const replace = async () => {
      if (replaced) return;
      replaced = true;
      await rename(replacementPath, result.lease.lockPath);
    };

    const released = await releaseLifetimeLease(result.lease, {
      fileSystem: {
        link,
        rename: async (source: string, target: string) => {
          if (source === result.lease.lockPath) await replace();
          return rename(source, target);
        },
        unlink: async (path: string) => {
          if (path === result.lease.lockPath) await replace();
          return unlink(path);
        },
      },
    });
    assert.equal(released, false);
    assert.equal(await readFile(result.lease.lockPath, "utf8"), replacement);
  });

  it("does not overwrite a replacement raced into the lock path during refresh", async () => {
    const directory = await temporaryDirectory();
    const result = await acquireLifetimeLease(directory, { pid: 4242 });
    assertWriter(result);
    const replacementPath = join(directory, "refresh-replacement.json");
    const replacement = lockRecord(4343, "d".repeat(32), ISO_2);
    await writeFile(replacementPath, replacement, { mode: 0o600 });
    let replaced = false;

    const refreshed = await refreshLifetimeLease(result.lease, {
      now: () => new Date(ISO_2),
      fileSystem: {
        link,
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (typeof args[1] !== "number" || (args[1] & constants.O_RDWR) === 0) {
            return handle;
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === "write") {
                return async (...writeArgs: Parameters<typeof target.write>) => {
                  if (!replaced) {
                    replaced = true;
                    await rename(replacementPath, result.lease.lockPath);
                  }
                  return target.write(...writeArgs);
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    });
    assert.equal(refreshed, false);
    assert.equal(await readFile(result.lease.lockPath, "utf8"), replacement);
  });

  it("cleans a refresh or release claim when the second witness read fails", async () => {
    for (const operation of ["refresh", "release"] as const) {
      const directory = await temporaryDirectory();
      const result = await acquireLifetimeLease(directory, { pid: process.pid });
      assertWriter(result);
      let witnessOpens = 0;
      const fileSystem = {
        open: async (...args: Parameters<typeof open>) => {
          if (
            basename(String(args[0])).startsWith(".sdl-observability-lifetime.claim-source.") &&
            typeof args[1] === "number" &&
            ++witnessOpens === 2
          ) {
            throw Object.assign(new Error("second witness read failed"), { code: "EIO" });
          }
          return open(...args);
        },
      };
      const completed = operation === "refresh"
        ? await refreshLifetimeLease(result.lease, {
            now: () => new Date(ISO_2),
            fileSystem,
          })
        : await releaseLifetimeLease(result.lease, { fileSystem });
      assert.equal(completed, false, operation);
      assert.deepEqual(await auxiliaryFiles(directory), [], operation);

      if (operation === "refresh") {
        assert.equal(await refreshLifetimeLease(result.lease, {
          now: () => new Date(ISO_2),
        }), true);
      }
      assert.equal(await releaseLifetimeLease(result.lease), true);
    }
  });

  it("rejects forged refresh and release leases outside their trusted directory", async () => {
    const trustedDirectory = await temporaryDirectory();
    const outsideDirectory = await temporaryDirectory();
    const outside = await acquireLifetimeLease(outsideDirectory, { pid: 4242 });
    assertWriter(outside);
    const outsideBefore = await readFile(outside.lease.lockPath, "utf8");
    const forgedLease: LifetimeWriterLease = {
      ...outside.lease,
      directory: trustedDirectory,
    };

    assert.equal(await refreshLifetimeLease(forgedLease, {
      now: () => new Date(ISO_2),
    }), false);
    assert.equal(await releaseLifetimeLease(forgedLease), false);
    assert.equal(await readFile(outside.lease.lockPath, "utf8"), outsideBefore);
    assert.equal(await releaseLifetimeLease(outside.lease), true);
  });

  it("keeps a running secondary read-only and lets only a new process acquire after release", async () => {
    const directory = await temporaryDirectory();
    const writer = await spawnWorker(directory);
    assert.deepEqual(await writer.next(), { event: "acquired", mode: "writer" });
    const secondary = await spawnWorker(directory);
    assert.deepEqual(await secondary.next(), { event: "acquired", mode: "readOnly" });

    writer.send("release");
    assert.deepEqual(await writer.next(), { event: "released", released: true });
    await writer.exited;
    await assert.rejects(lstat(join(directory, LIFETIME_LOCK_FILENAME)), { code: "ENOENT" });
    secondary.send("state");
    assert.deepEqual(await secondary.next(), {
      event: "state",
      mode: "readOnly",
      lockExists: false,
      claimExists: false,
    });
    await assert.rejects(lstat(join(directory, LIFETIME_LOCK_FILENAME)), { code: "ENOENT" });

    const successor = await spawnWorker(directory);
    assert.deepEqual(await successor.next(), { event: "acquired", mode: "writer" });
    successor.send("release");
    assert.deepEqual(await successor.next(), { event: "released", released: true });
    await successor.exited;
    secondary.send("exit");
    await secondary.exited;
  });
});
