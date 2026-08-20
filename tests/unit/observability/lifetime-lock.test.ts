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
  opendir,
  readFile,
  realpath,
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
  readLifetimeSource,
  resolveLifetimeFileSystem,
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
const WORKER_TIMEOUT_MS = 5_000;

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
  const stat = await lstat(path, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: Number(stat.size),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

interface TestIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function identityStat<T extends object>(stat: T, identity: TestIdentity): T {
  const bigint = typeof Reflect.get(stat, "dev") === "bigint";
  return new Proxy(stat, {
    get(target, property, receiver) {
      if (property === "dev") return bigint ? identity.dev : Number(identity.dev);
      if (property === "ino") return bigint ? identity.ino : Number(identity.ino);
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function identityFixtureFileSystem(identityForPath: (path: string) => TestIdentity | undefined) {
  return {
    lstat: async (...args: Parameters<typeof lstat>) => {
      const stat = await lstat(...args);
      const identity = identityForPath(String(args[0]));
      return identity ? identityStat(stat, identity) : stat;
    },
    open: async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      const identity = identityForPath(String(args[0]));
      if (!identity) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "stat") {
            return async (...statArguments: Parameters<typeof target.stat>) =>
              identityStat(await target.stat(...statArguments), identity);
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
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
  assert.equal(result.mode, "writer", JSON.stringify(result));
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

async function auxiliaryContents(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await auxiliaryFiles(directory)).map(async (name) =>
    [name, (await readFile(join(directory, name))).toString("base64")] as const)));
}

async function writeExactAuxiliaryAliases(
  directory: string,
  logicalName: string,
  suffixes: readonly string[],
  content: string,
): Promise<void> {
  const [first, ...rest] = suffixes;
  assert.notEqual(first, undefined);
  const source = join(directory, `${logicalName}${first}`);
  await writeFile(source, content, { mode: 0o600 });
  for (const suffix of rest) await link(source, join(directory, `${logicalName}${suffix}`));
}

function normalizationCandidateName(
  logicalName: string,
  entryName: string,
  snapshot: Awaited<ReturnType<typeof fileSnapshot>>,
  attempt = 0,
): string {
  const hash = createHash("sha256")
    .update(entryName)
    .update("\0")
    .update(snapshot.dev)
    .update("\0")
    .update(snapshot.ino)
    .update("\0")
    .update(snapshot.sha256);
  if (attempt > 0) hash.update("\0").update(String(attempt));
  return `${logicalName}.normalize.${hash.digest("hex").slice(0, 32)}`;
}

async function writeEvidenceDeletionDuplicate(
  directory: string,
  index: number,
): Promise<{
  readonly targetPath: string;
  readonly deleteName: string;
  readonly deletePath: string;
  readonly snapshot: Awaited<ReturnType<typeof fileSnapshot>>;
}> {
  const timestamp = (1_700_000_100_000 + index).toString(36).padStart(11, "0");
  const nonce = (0xe0 + index).toString(16).padStart(32, "0");
  const targetName =
    `sdl-observability-lifetime.evidence.v1.validated-supported.lock.${timestamp}.${nonce}.json`;
  const targetPath = join(directory, targetName);
  const deleteName = `.sdl-observability-lifetime.delete.${targetName}`;
  const deletePath = join(directory, deleteName);
  await writeFile(targetPath, lockRecord(95_000 + index));
  await link(targetPath, deletePath);
  return {
    targetPath,
    deleteName,
    deletePath,
    snapshot: await fileSnapshot(deletePath),
  };
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
  const next = (timeoutMs = WORKER_TIMEOUT_MS) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const queued = queue.shift();
    if (queued) {
      resolve(queued);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const finish = (message: Record<string, unknown>) => {
      if (timer) clearTimeout(timer);
      child.off("error", fail);
      child.off("exit", onExit);
      resolve(message);
    };
    const fail = (error: Error) => {
      if (timer) clearTimeout(timer);
      const index = waiters.indexOf(finish);
      if (index >= 0) waiters.splice(index, 1);
      child.kill();
      reject(error);
    };
    const onExit = (code: number | null) => {
      if (code !== null && code !== 0) {
        fail(new Error(`lock worker exited ${code}: ${child.stderr.read() ?? ""}`));
      }
    };
    waiters.push(finish);
    child.once("error", fail);
    child.once("exit", onExit);
    timer = setTimeout(() => fail(new Error(`lock worker timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  const send = (command: "state" | "release" | "exit") => child.stdin.write(`${command}\n`);
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`lock worker did not exit after ${WORKER_TIMEOUT_MS}ms`));
    }, WORKER_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
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
    const timer = setTimeout(resolve, WORKER_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  })));
  children.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("lifetime persistence lock", () => {
  it("reads sources through a bounded loop and detects growth or shrink races", async () => {
    const directory = await temporaryDirectory();
    const growing = join(directory, "growing.json");
    await writeFile(growing, "x");
    let usedReadFile = false;
    let largestRead = 0;
    let grew = false;
    const growingFileSystem = resolveLifetimeFileSystem({
      open: async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]) !== growing) return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "readFile") {
              return async () => {
                usedReadFile = true;
                return target.readFile();
              };
            }
            if (property === "read") {
              return async (buffer: Buffer, offset: number, length: number, position: number) => {
                largestRead = Math.max(largestRead, length);
                if (!grew) {
                  grew = true;
                  await writeFile(growing, "x".repeat(1024 * 1024));
                }
                return target.read(buffer, offset, length, position);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    await assert.rejects(readLifetimeSource(growing, growingFileSystem, 1), /size limit|changed/);
    assert.equal(usedReadFile, false);
    assert.ok(largestRead <= 2, `bounded read requested ${largestRead} bytes`);

    const shrinking = join(directory, "shrinking.json");
    await writeFile(shrinking, "four");
    let shrank = false;
    const shrinkingFileSystem = resolveLifetimeFileSystem({
      open: async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]) !== shrinking) return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "read") {
              return async (buffer: Buffer, offset: number, length: number, position: number) => {
                if (!shrank) {
                  shrank = true;
                  await writeFile(shrinking, "tw");
                }
                return target.read(buffer, offset, length, position);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    await assert.rejects(readLifetimeSource(shrinking, shrinkingFileSystem, 8), /changed/);
  });

  it("keeps file identities lossless above Number.MAX_SAFE_INTEGER", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "high-identity-source.json");
    await writeFile(source, lockRecord(4_001));
    const low = { dev: 9_007_199_254_740_992n, ino: 9_007_199_254_740_992n };
    const high = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_993n };

    const stable = await readLifetimeSource(
      source,
      resolveLifetimeFileSystem(identityFixtureFileSystem(() => high)),
    );
    assert.equal(stable.snapshot.dev, high.dev.toString());
    assert.equal(stable.snapshot.ino, high.ino.toString());

    let identityReads = 0;
    const changingFileSystem = resolveLifetimeFileSystem(identityFixtureFileSystem((path) => {
      if (path !== source) return undefined;
      identityReads++;
      return identityReads <= 2 ? low : high;
    }));
    await assert.rejects(
      readLifetimeSource(source, changingFileSystem),
      /changed while reading/,
    );
  });

  it("keeps rounded high-bit source identities in separate cleanup groups", async () => {
    const directory = await temporaryDirectory();
    const low = { dev: 9_007_199_254_740_992n, ino: 9_007_199_254_740_992n };
    const high = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_993n };
    assert.equal(Number(low.ino), Number(high.ino), "the regression fixture aliases as Number");
    const content = lockRecord(4_002);
    const sourceSize = Buffer.byteLength(content);
    const sourceHash = createHash("sha256").update(content).digest("hex");
    const identities = new Map<string, TestIdentity>();
    for (let index = 0; index < 16; index++) {
      const nonce = (index + 500).toString(16).padStart(32, "0");
      const identity = index < 8 ? low : high;
      identities.set(nonce, identity);
      const snapshot = {
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
        size: sourceSize,
        sha256: sourceHash,
      };
      await writeFile(
        join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
        claimRecord(999_999, nonce, snapshot),
      );
      await writeFile(
        join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`),
        content,
      );
    }
    const fixture = identityFixtureFileSystem((path) => {
      for (const [nonce, identity] of identities) {
        if (basename(path).includes(nonce)) return identity;
      }
      return undefined;
    });

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
      fileSystem: fixture,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "contended" });
    for (let index = 0; index < 16; index++) {
      const nonce = (index + 500).toString(16).padStart(32, "0");
      const recordPath = join(
        directory,
        `.sdl-observability-lifetime.claim-record.${nonce}.json`,
      );
      const witnessPath = join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`);
      if (index < 8) {
        await assertMissing(recordPath);
        await assertMissing(witnessPath);
      } else {
        assert.equal((await lstat(recordPath)).isFile(), true, `record ${index}`);
        assert.equal((await lstat(witnessPath)).isFile(), true, `witness ${index}`);
      }
    }
    const successor = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
      fileSystem: fixture,
    });
    assertWriter(successor);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
  });

  it("rejects non-canonical persisted device and inode strings", async () => {
    for (const [field, value] of [
      ["dev", "01"],
      ["ino", "+1"],
      ["dev", "-1"],
    ] as const) {
      const directory = await temporaryDirectory();
      const nonce = "f".repeat(32);
      const path = join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`);
      const source = {
        dev: "0",
        ino: "0",
        size: 0,
        sha256: createHash("sha256").update("").digest("hex"),
        [field]: value,
      };
      await writeFile(path, claimRecord(999_999, nonce, source));

      const result = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" }, `${field}:${value}`);
      assert.equal((await lstat(path)).isFile(), true);
    }
  });

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

  it("does not grant a writer lease when created-file identity is unavailable", async () => {
    const directory = await temporaryDirectory();
    const zero = { dev: 0n, ino: 0n };
    const fixture = identityFixtureFileSystem((path) => {
      const name = basename(path);
      return name === LIFETIME_LOCK_FILENAME ||
          name.startsWith(".sdl-observability-lifetime.create.") ||
          name.startsWith(".sdl-observability-lifetime.create-source.") ||
          name.startsWith(".sdl-observability-lifetime.create-lock.") ||
          name.startsWith(".sdl-observability-lifetime.claim-source.") ||
          name.startsWith(".sdl-observability-lifetime.release.")
        ? zero
        : undefined;
    });

    const result = await acquireLifetimeLease(directory, {
      now: () => new Date(ISO_1),
      pid: 4242,
      randomBytes: () => Buffer.alloc(16, 0x61),
      fileSystem: fixture,
    });
    assert.equal(result.mode, "readOnly");
    await assertMissing(join(directory, LIFETIME_LOCK_FILENAME));
  });

  it("invalidates a post-write inode-zero lock before returning read-only", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const zero = { dev: 0n, ino: 0n };
    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      randomBytes: () => Buffer.alloc(16, 0x62),
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (String(args[0]) !== lockPath || args[1] !== "wx") return handle;
          let statCalls = 0;
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === "stat") {
                return async (...statArguments: Parameters<typeof target.stat>) => {
                  statCalls++;
                  const stat = await target.stat(...statArguments);
                  return statCalls === 1 ? stat : identityStat(stat, zero);
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" });
    assert.equal((await readFile(lockPath)).length, 0);
  });

  it("preserves a same-content inode-zero replacement during release", async () => {
    const directory = await temporaryDirectory();
    const acquired = await acquireLifetimeLease(directory, { pid: 4242 });
    assertWriter(acquired);
    const content = await readFile(acquired.lease.lockPath, "utf8");
    await unlink(acquired.lease.lockPath);
    await writeFile(acquired.lease.lockPath, content, { mode: 0o600 });
    const zero = { dev: 0n, ino: 0n };
    const fixture = identityFixtureFileSystem((path) =>
      basename(path) === LIFETIME_LOCK_FILENAME ||
        basename(path).startsWith(".sdl-observability-lifetime.")
        ? zero
        : undefined);

    assert.equal(await releaseLifetimeLease(acquired.lease, { fileSystem: fixture }), false);
    assert.equal(await readFile(acquired.lease.lockPath, "utf8"), content);
  });

  it("stops before writing an inode-zero create anchor and preserves its exact witness", async () => {
    const directory = await temporaryDirectory();
    const nonce = "65".repeat(16);
    const zero = { dev: 0n, ino: 0n };
    let wrote = false;
    const base = identityFixtureFileSystem((path) =>
      basename(path).includes(nonce) ? zero : undefined);
    const result = await acquireLifetimeLease(directory, {
      randomBytes: () => Buffer.from(nonce, "hex"),
      fileSystem: {
        ...base,
        open: async (...args: Parameters<typeof open>) => {
          const handle = await base.open(...args);
          if (!basename(String(args[0])).startsWith(".sdl-observability-lifetime.create.")) {
            return handle;
          }
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === "writeFile") {
                return async (...writeArguments: Parameters<typeof target.writeFile>) => {
                  wrote = true;
                  return target.writeFile(...writeArguments);
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" });
    assert.equal(wrote, false);
    await assertMissing(join(directory, LIFETIME_LOCK_FILENAME));
    assert.deepEqual(await auxiliaryFiles(directory), [
      `.sdl-observability-lifetime.create-source.${nonce}`,
      `.sdl-observability-lifetime.create.${nonce}`,
    ]);
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

  it("recovers an ordinary create anchor interrupted after its cleanup rename", async () => {
    const directory = await temporaryDirectory();
    const nonce = "71".repeat(16);
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.create.${nonce}.cleanup`,
    );
    let interrupted = false;
    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      randomBytes: () => Buffer.from(nonce, "hex"),
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          if (!interrupted && String(args[0]) === cleanupPath) {
            interrupted = true;
            throw Object.assign(new Error("anchor cleanup interrupted"), { code: "EIO" });
          }
          return open(...args);
        },
      },
    });
    assertWriter(result);
    assert.equal(interrupted, true);
    assert.equal((await lstat(cleanupPath)).isFile(), true);
    assert.equal(
      (await auxiliaryFiles(directory)).some((name) => name.includes("create-source")),
      false,
    );
    assert.equal(await releaseLifetimeLease(result.lease), true);

    const successor = await acquireLifetimeLease(directory, {
      pid: 4343,
      randomBytes: () => Buffer.alloc(16, 0x72),
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
  });

  it("recovers exact create cleanup aliases across two startups", async () => {
    const directory = await temporaryDirectory();
    const nonce = "79".repeat(16);
    const anchorPath = join(directory, `.sdl-observability-lifetime.create.${nonce}`);
    const cleanupPath = `${anchorPath}.cleanup`;
    await writeFile(anchorPath, createAnchorRecord(999_999, nonce));
    await link(anchorPath, cleanupPath);
    let interrupted = false;

    const first = await acquireLifetimeLease(directory, {
      pid: 4242,
      isClaimantPidAlive: () => false,
      fileSystem: {
        unlink: async (path) => {
          if (!interrupted && String(path).includes(".normalize.")) {
            interrupted = true;
            throw Object.assign(new Error("create alias cleanup interrupted"), { code: "EIO" });
          }
          return unlink(path);
        },
      },
    });
    assert.equal(first.mode, "readOnly");
    assert.equal(interrupted, true);

    const successor = await acquireLifetimeLease(directory, {
      pid: 4343,
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
  });

  it("recovers every exact create alias suffix combination", async () => {
    const combinations = [
      [""],
      [".cleanup"],
      [".cleanup-next"],
      ["", ".cleanup"],
      ["", ".cleanup-next"],
      [".cleanup", ".cleanup-next"],
      ["", ".cleanup", ".cleanup-next"],
    ] as const;

    for (const [index, suffixes] of combinations.entries()) {
      const directory = await temporaryDirectory();
      const nonce = (0x90 + index).toString(16).padStart(32, "0");
      const logicalName = `.sdl-observability-lifetime.create.${nonce}`;
      await writeExactAuxiliaryAliases(
        directory,
        logicalName,
        suffixes,
        createAnchorRecord(999_999, nonce),
      );

      let result: Awaited<ReturnType<typeof acquireLifetimeLease>> | undefined;
      for (let startup = 0; startup < 3; startup++) {
        result = await acquireLifetimeLease(directory, {
          isClaimantPidAlive: () => false,
        });
        if (result.mode === "writer") break;
      }
      assert.notEqual(result, undefined, suffixes.join(" + "));
      assertWriter(result);
      assert.equal(await releaseLifetimeLease(result.lease), true);
      assert.deepEqual(await auxiliaryFiles(directory), [], suffixes.join(" + "));
    }
  });

  it("resumes exact alias normalization after every mutation boundary", async () => {
    for (const stage of ["link", "canonical-read", "alias-rename", "alias-read", "alias-unlink"] as const) {
      const directory = await temporaryDirectory();
      const nonce = ({
        link: "a1",
        "canonical-read": "a2",
        "alias-rename": "a3",
        "alias-read": "a4",
        "alias-unlink": "a5",
      } as const)[stage].repeat(16);
      const logicalName = `.sdl-observability-lifetime.create.${nonce}`;
      const canonicalPath = join(directory, logicalName);
      await writeExactAuxiliaryAliases(
        directory,
        logicalName,
        [".cleanup", ".cleanup-next"],
        createAnchorRecord(999_999, nonce),
      );
      let canonicalLinked = false;
      let interrupted = false;

      const first = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
        fileSystem: {
          link: async (...args: Parameters<typeof link>) => {
            if (!interrupted && stage === "link" && String(args[1]) === canonicalPath) {
              await link(...args);
              canonicalLinked = true;
              interrupted = true;
              throw Object.assign(new Error("normalization link interrupted"), { code: "EIO" });
            }
            const result = await link(...args);
            if (String(args[1]) === canonicalPath) canonicalLinked = true;
            return result;
          },
          open: async (...args: Parameters<typeof open>) => {
            const path = String(args[0]);
            if (
              !interrupted &&
              ((stage === "canonical-read" && canonicalLinked && path === canonicalPath) ||
                (stage === "alias-read" && path.includes(".normalize.")))
            ) {
              interrupted = true;
              throw Object.assign(new Error("normalization read interrupted"), { code: "EIO" });
            }
            return open(...args);
          },
          rename: async (...args: Parameters<typeof rename>) => {
            if (!interrupted && stage === "alias-rename" && String(args[1]).includes(".normalize.")) {
              await rename(...args);
              interrupted = true;
              throw Object.assign(new Error("normalization rename interrupted"), { code: "EIO" });
            }
            return rename(...args);
          },
          unlink: async (...args: Parameters<typeof unlink>) => {
            if (!interrupted && stage === "alias-unlink" && String(args[0]).includes(".normalize.")) {
              await unlink(...args);
              interrupted = true;
              throw Object.assign(new Error("normalization unlink interrupted"), { code: "EIO" });
            }
            return unlink(...args);
          },
        },
      });
      assert.equal(first.mode, "readOnly", stage);
      assert.equal(interrupted, true, stage);

      let successor: Awaited<ReturnType<typeof acquireLifetimeLease>> | undefined;
      for (let startup = 0; startup < 3; startup++) {
        successor = await acquireLifetimeLease(directory, {
          isClaimantPidAlive: () => false,
        });
        if (successor.mode === "writer") break;
      }
      assert.notEqual(successor, undefined, stage);
      assertWriter(successor);
      assert.equal(await releaseLifetimeLease(successor.lease), true, stage);
      assert.deepEqual(await auxiliaryFiles(directory), [], stage);
    }
  });

  it("recovers an exact normalize continuation interrupted after alias restoration", async () => {
    const directory = await temporaryDirectory();
    const nonce = "a6".repeat(16);
    const logicalName = `.sdl-observability-lifetime.create.${nonce}`;
    const canonicalPath = join(directory, logicalName);
    const aliasPath = `${canonicalPath}.cleanup`;
    await writeFile(canonicalPath, createAnchorRecord(999_999, nonce));
    await link(canonicalPath, aliasPath);
    const snapshot = await fileSnapshot(aliasPath);
    const candidatePath = join(
      directory,
      normalizationCandidateName(logicalName, basename(aliasPath), snapshot),
    );
    let corruptCandidateRead = true;
    let interrupted = false;

    const first = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (!corruptCandidateRead || String(args[0]) !== candidatePath) return handle;
          corruptCandidateRead = false;
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === "read") {
                return async (buffer: Buffer, offset: number, length: number, position: number) => {
                  const result = await target.read(buffer, offset, length, position);
                  if (result.bytesRead > 0) buffer[offset] = buffer[offset] === 0x7b ? 0x5b : 0x7b;
                  return result;
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        unlink: async (...args: Parameters<typeof unlink>) => {
          if (!interrupted && String(args[0]) === candidatePath) {
            interrupted = true;
            throw Object.assign(new Error("restored candidate unlink interrupted"), { code: "EIO" });
          }
          return unlink(...args);
        },
      },
    });
    assert.equal(first.mode, "readOnly");
    assert.equal(interrupted, true);
    assert.equal((await lstat(aliasPath, { bigint: true })).ino,
      (await lstat(candidatePath, { bigint: true })).ino);

    let successor: Awaited<ReturnType<typeof acquireLifetimeLease>> | undefined;
    for (let startup = 0; startup < 3; startup++) {
      successor = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      if (successor.mode === "writer") break;
    }
    assert.notEqual(successor, undefined);
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
  });

  it("fails closed without mutation for mismatched or exhausted normalize slots", async () => {
    for (const state of ["mismatch", "exhausted"] as const) {
      const directory = await temporaryDirectory();
      const nonce = (state === "mismatch" ? "a7" : "a8").repeat(16);
      const logicalName = `.sdl-observability-lifetime.create.${nonce}`;
      const canonicalPath = join(directory, logicalName);
      const aliasPath = `${canonicalPath}.cleanup`;
      await writeFile(canonicalPath, createAnchorRecord(999_999, nonce));
      await link(canonicalPath, aliasPath);
      const snapshot = await fileSnapshot(aliasPath);
      const attempts = state === "mismatch" ? [0] : [0, 1, 2, 3];
      for (const attempt of attempts) {
        const candidatePath = join(
          directory,
          normalizationCandidateName(logicalName, basename(aliasPath), snapshot, attempt),
        );
        if (state === "mismatch") {
          await writeFile(candidatePath, createAnchorRecord(999_999, nonce, 999_999, ISO_2));
        } else {
          await link(aliasPath, candidatePath);
        }
      }
      const before = await auxiliaryContents(directory);

      const result = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" }, state);
      assert.deepEqual(await auxiliaryContents(directory), before, state);
    }
  });

  it("preserves exact create cleanup aliases for a live claimant", async () => {
    const directory = await temporaryDirectory();
    const nonce = "7a".repeat(16);
    const anchorPath = join(directory, `.sdl-observability-lifetime.create.${nonce}`);
    const cleanupPath = `${anchorPath}.cleanup`;
    await writeFile(anchorPath, createAnchorRecord(4242, nonce));
    await link(anchorPath, cleanupPath);
    const before = await auxiliaryFiles(directory);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: (pid) => pid === 4242,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "contended" });
    assert.deepEqual(await auxiliaryFiles(directory), before);
  });

  it("preserves mismatched create cleanup aliases as invalid", async () => {
    const directory = await temporaryDirectory();
    const nonce = "7b".repeat(16);
    const anchorPath = join(directory, `.sdl-observability-lifetime.create.${nonce}`);
    const cleanupPath = `${anchorPath}.cleanup`;
    await writeFile(anchorPath, createAnchorRecord(999_999, nonce));
    await writeFile(cleanupPath, createAnchorRecord(999_999, nonce, 999_999, ISO_2));
    const before = await auxiliaryFiles(directory);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" });
    assert.deepEqual(await auxiliaryFiles(directory), before);
  });

  it("preserves an inode-zero lock-witness cleanup path fail closed", async () => {
    const directory = await temporaryDirectory();
    const nonce = "73".repeat(16);
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.create-lock.${nonce}.cleanup-next`,
    );
    const zero = { dev: 0n, ino: 0n };
    const base = identityFixtureFileSystem((path) => {
      const name = basename(path);
      return name === LIFETIME_LOCK_FILENAME ||
          name.startsWith(".sdl-observability-lifetime.create.") ||
          name.startsWith(".sdl-observability-lifetime.create-source.") ||
          name.startsWith(".sdl-observability-lifetime.create-lock.") ||
          name.startsWith(".sdl-observability-lifetime.claim-source.") ||
          name.startsWith(".sdl-observability-lifetime.release.")
        ? zero
        : undefined;
    });
    let interrupted = false;
    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      randomBytes: () => Buffer.from(nonce, "hex"),
      fileSystem: {
        ...base,
        open: async (...args: Parameters<typeof open>) => {
          if (!interrupted && String(args[0]) === cleanupPath) {
            interrupted = true;
            throw Object.assign(new Error("lock witness cleanup interrupted"), { code: "EIO" });
          }
          return base.open(...args);
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" });
    assert.equal(interrupted, false);
    const preserved = await auxiliaryFiles(directory);
    assert.ok(preserved.length >= 2);

    const successor = await acquireLifetimeLease(directory, {
      pid: 4343,
      randomBytes: () => Buffer.alloc(16, 0x74),
      isClaimantPidAlive: () => false,
      fileSystem: base,
    });
    assert.equal(successor.mode, "readOnly");
    assert.deepEqual(await auxiliaryFiles(directory), preserved);
  });

  it("preserves an inode-zero created-lock cleanup path fail closed", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const nonce = "77".repeat(16);
    const witnessPath = join(
      directory,
      `.sdl-observability-lifetime.create-lock.${nonce}`,
    );
    const cleanupPath = `${witnessPath}.cleanup-next`;
    const zero = { dev: 0n, ino: 0n };
    const base = identityFixtureFileSystem((path) => {
      const name = basename(path);
      return name === LIFETIME_LOCK_FILENAME ||
          name.startsWith(".sdl-observability-lifetime.create.") ||
          name.startsWith(".sdl-observability-lifetime.create-source.") ||
          name.startsWith(".sdl-observability-lifetime.create-lock.") ||
          name.startsWith(".sdl-observability-lifetime.claim-source.") ||
          name.startsWith(".sdl-observability-lifetime.release.")
        ? zero
        : undefined;
    });
    let validationFailed = false;
    let cleanupInterrupted = false;
    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      randomBytes: () => Buffer.from(nonce, "hex"),
      fileSystem: {
        ...base,
        open: async (...args: Parameters<typeof open>) => {
          const path = String(args[0]);
          if (!validationFailed && path === lockPath && typeof args[1] === "number") {
            validationFailed = true;
            throw Object.assign(new Error("inode-zero validation failed"), { code: "EIO" });
          }
          if (validationFailed && !cleanupInterrupted && path === cleanupPath) {
            cleanupInterrupted = true;
            throw Object.assign(new Error("created lock cleanup interrupted"), { code: "EIO" });
          }
          return base.open(...args);
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" });
    assert.equal(validationFailed, false);
    assert.equal(cleanupInterrupted, false);
    const preserved = await auxiliaryFiles(directory);
    assert.ok(preserved.length >= 2);

    const successor = await acquireLifetimeLease(directory, {
      pid: 4343,
      randomBytes: () => Buffer.alloc(16, 0x78),
      isClaimantPidAlive: () => false,
      fileSystem: base,
    });
    assert.equal(successor.mode, "readOnly");
    assert.deepEqual(await auxiliaryFiles(directory), preserved);
  });

  it("recovers a created lock interrupted after its cleanup rename", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const nonce = "75".repeat(16);
    const candidatePath = join(
      directory,
      `.sdl-observability-lifetime.create-lock.${nonce}`,
    );
    let validationFailed = false;
    let cleanupInterrupted = false;
    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      randomBytes: () => Buffer.from(nonce, "hex"),
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          const path = String(args[0]);
          if (!validationFailed && path === lockPath && typeof args[1] === "number") {
            validationFailed = true;
            throw Object.assign(new Error("lock validation failed"), { code: "EIO" });
          }
          if (!cleanupInterrupted && path === candidatePath) {
            cleanupInterrupted = true;
            throw Object.assign(new Error("created lock cleanup interrupted"), { code: "EIO" });
          }
          return open(...args);
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" });
    assert.equal(validationFailed, true);
    assert.equal(cleanupInterrupted, true);
    assert.equal((await lstat(candidatePath)).isFile(), true);
    assert.equal(
      (await auxiliaryFiles(directory)).some((name) => name === `.sdl-observability-lifetime.create.${nonce}`),
      true,
    );

    const successor = await acquireLifetimeLease(directory, {
      pid: 4343,
      randomBytes: () => Buffer.alloc(16, 0x76),
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
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

  it("recovers exact fixed and claim-cleanup aliases across two startups", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    const nonce = "7c".repeat(16);
    const recordPath = join(
      directory,
      `.sdl-observability-lifetime.claim-record.${nonce}.json`,
    );
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
    );
    const recoveryMovedPath = join(
      directory,
      `.sdl-observability-lifetime.claim-recovery-moved.${nonce}`,
    );
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    const source = await fileSnapshot(lockPath);
    await writeFile(recordPath, claimRecord(999_999, nonce, source));
    await link(recordPath, fixedPath);
    await link(recordPath, cleanupPath);
    let interrupted = false;

    const first = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
      fileSystem: {
        unlink: async (path) => {
          if (!interrupted && String(path) === recoveryMovedPath) {
            interrupted = true;
            throw Object.assign(new Error("claim alias recovery interrupted"), { code: "EIO" });
          }
          return unlink(path);
        },
      },
    });
    assert.equal(first.mode, "readOnly");
    assert.equal(interrupted, true);

    const successor = await acquireLifetimeLease(directory, {
      pid: 4343,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
  });

  it("keeps an exact fixed and claim-cleanup alias authoritative while claimant is live", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    const nonce = "7d".repeat(16);
    const recordPath = join(
      directory,
      `.sdl-observability-lifetime.claim-record.${nonce}.json`,
    );
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
    );
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    const source = await fileSnapshot(lockPath);
    await writeFile(recordPath, claimRecord(4242, nonce, source));
    await link(recordPath, fixedPath);
    await link(recordPath, cleanupPath);
    const before = await auxiliaryFiles(directory);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: (pid) => pid === 4242,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "contended" });
    assert.deepEqual(await auxiliaryFiles(directory), before);
  });

  it("preserves mismatched fixed and claim-cleanup aliases as invalid", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    const nonce = "7e".repeat(16);
    const recordPath = join(
      directory,
      `.sdl-observability-lifetime.claim-record.${nonce}.json`,
    );
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
    );
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    const source = await fileSnapshot(lockPath);
    await writeFile(recordPath, claimRecord(999_999, nonce, source));
    await link(recordPath, fixedPath);
    await writeFile(cleanupPath, claimRecord(999_999, nonce, source, ISO_2));
    const before = await auxiliaryFiles(directory);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" });
    assert.deepEqual(await auxiliaryFiles(directory), before);
  });

  it("retries initial fixed-claim EPERM or EACCES after an exact cleanup rename", async () => {
    for (const code of ["EPERM", "EACCES"] as const) {
      const directory = await temporaryDirectory();
      const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
      const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
      await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
      await crashClaimWorker(directory, lockPath, "claim-before-move");
      const recordName = (await readdir(directory)).find((name) =>
        name.startsWith(".sdl-observability-lifetime.claim-record."));
      assert.ok(recordName);
      const nonce = recordName.slice(
        ".sdl-observability-lifetime.claim-record.".length,
        -".json".length,
      );
      const cleanupPath = join(
        directory,
        `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
      );
      let raced = false;

      const result = await acquireLifetimeLease(directory, {
        pid: 4242,
        isPidAlive: () => false,
        isClaimantPidAlive: () => false,
        fileSystem: {
          open: async (...args: Parameters<typeof open>) => {
            if (!raced && String(args[0]) === fixedPath) {
              raced = true;
              await rename(fixedPath, cleanupPath);
              throw Object.assign(new Error(`initial fixed claim ${code}`), { code });
            }
            return open(...args);
          },
        },
      });
      assert.equal(raced, true, code);
      assertWriter(result);
      assert.equal(await releaseLifetimeLease(result.lease), true);
    }
  });

  it("fails closed after bounded initial fixed-claim access denial", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");
    const before = await auxiliaryFiles(directory);
    let fixedOpens = 0;

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          if (String(args[0]) === fixedPath) {
            fixedOpens++;
            throw Object.assign(new Error("fixed claim remains inaccessible"), { code: "EPERM" });
          }
          return open(...args);
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" });
    assert.ok(fixedOpens >= 2 && fixedOpens <= 16, `bounded opens: ${fixedOpens}`);
    assert.deepEqual(await auxiliaryFiles(directory), before);
  });

  it("retries fixed-claim lstat denial during an exact cleanup rename", async () => {
    for (const boundary of ["absence", "recovery"] as const) {
      for (const code of ["EPERM", "EACCES"] as const) {
        const directory = await temporaryDirectory();
        const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
        const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
        await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
        await crashClaimWorker(directory, lockPath, "claim-before-move");
        const recordName = (await readdir(directory)).find((name) =>
          name.startsWith(".sdl-observability-lifetime.claim-record."));
        assert.ok(recordName);
        const nonce = recordName.slice(
          ".sdl-observability-lifetime.claim-record.".length,
          -".json".length,
        );
        const cleanupPath = join(
          directory,
          `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
        );
        let fixedLstats = 0;
        let raced = false;

        const result = await acquireLifetimeLease(directory, {
          pid: 4242,
          isPidAlive: () => false,
          isClaimantPidAlive: () => false,
          fileSystem: {
            lstat: async (...args: Parameters<typeof lstat>) => {
              if (String(args[0]) === fixedPath) {
                fixedLstats++;
                const target = boundary === "absence" ? 1 : 2;
                if (!raced && fixedLstats === target) {
                  raced = true;
                  await rename(fixedPath, cleanupPath);
                  throw Object.assign(new Error(`${boundary} lstat ${code}`), { code });
                }
              }
              return lstat(...args);
            },
          },
        });
        assert.equal(raced, true, `${boundary}:${code}`);
        assertWriter(result);
        assert.equal(await releaseLifetimeLease(result.lease), true);
      }
    }
  });

  it("fails closed after bounded fixed-claim lstat denial", async () => {
    for (const boundary of ["absence", "recovery"] as const) {
      const directory = await temporaryDirectory();
      const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
      const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
      await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
      await crashClaimWorker(directory, lockPath, "claim-before-move");
      const before = await auxiliaryFiles(directory);
      let fixedLstats = 0;

      const result = await acquireLifetimeLease(directory, {
        pid: 4242,
        isPidAlive: () => false,
        isClaimantPidAlive: () => false,
        fileSystem: {
          lstat: async (...args: Parameters<typeof lstat>) => {
            if (String(args[0]) === fixedPath) {
              fixedLstats++;
              if (boundary === "absence" || fixedLstats > 1) {
                throw Object.assign(new Error(`${boundary} lstat remains inaccessible`), {
                  code: boundary === "absence" ? "EPERM" : "EACCES",
                });
              }
            }
            return lstat(...args);
          },
        },
      });
      assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" }, boundary);
      assert.ok(fixedLstats >= 2 && fixedLstats <= 16, `${boundary}:${fixedLstats}`);
      assert.deepEqual(await auxiliaryFiles(directory), before);
    }
  });

  it("rechecks a claim when a raced witness open reports EPERM", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");
    let raced = false;

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          if (
            !raced &&
            basename(String(args[0])).startsWith(".sdl-observability-lifetime.claim-source.")
          ) {
            raced = true;
            await unlink(fixedPath);
            throw Object.assign(new Error("witness link raced away"), { code: "EPERM" });
          }
          return open(...args);
        },
      },
    });
    assert.equal(raced, true);
    assertWriter(result);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("fails closed when EPERM leaves the exact claim and record unchanged", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");
    const before = await auxiliaryFiles(directory);
    let denied = false;

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          if (
            !denied &&
            basename(String(args[0])).startsWith(".sdl-observability-lifetime.claim-source.")
          ) {
            denied = true;
            throw Object.assign(new Error("witness access denied"), { code: "EPERM" });
          }
          return open(...args);
        },
      },
    });
    assert.equal(denied, true);
    assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" });
    assert.deepEqual(await auxiliaryFiles(directory), before);
  });

  it("recognizes an exact matching cleanup artifact during witness EPERM", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");
    const recordName = (await readdir(directory)).find((name) =>
      name.startsWith(".sdl-observability-lifetime.claim-record."));
    assert.ok(recordName);
    const nonce = recordName.slice(
      ".sdl-observability-lifetime.claim-record.".length,
      -".json".length,
    );
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
    );
    let denied = false;
    let fixedRemoved = false;

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          const path = String(args[0]);
          if (
            !denied &&
            basename(path).startsWith(".sdl-observability-lifetime.claim-source.")
          ) {
            denied = true;
            await link(fixedPath, cleanupPath);
            throw Object.assign(new Error("witness denied during cleanup"), { code: "EPERM" });
          }
          const handle = await open(...args);
          if (path === cleanupPath && !fixedRemoved) {
            fixedRemoved = true;
            await unlink(fixedPath);
          }
          return handle;
        },
      },
    });
    assert.equal(denied, true);
    assert.equal(fixedRemoved, true);
    assertWriter(result);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("boundedly rechecks EPERM until matching cleanup becomes visible", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");
    const recordName = (await readdir(directory)).find((name) =>
      name.startsWith(".sdl-observability-lifetime.claim-record."));
    assert.ok(recordName);
    const nonce = recordName.slice(
      ".sdl-observability-lifetime.claim-record.".length,
      -".json".length,
    );
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
    );
    let witnessDenied = false;
    let cleanupChecks = 0;
    let fixedRemoved = false;

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
      fileSystem: {
        lstat: async (...args: Parameters<typeof lstat>) => {
          if (String(args[0]) === cleanupPath && ++cleanupChecks === 2) {
            await link(fixedPath, cleanupPath);
          }
          return lstat(...args);
        },
        open: async (...args: Parameters<typeof open>) => {
          const path = String(args[0]);
          if (
            !witnessDenied &&
            basename(path).startsWith(".sdl-observability-lifetime.claim-source.")
          ) {
            witnessDenied = true;
            throw Object.assign(new Error("witness denied before cleanup appears"), {
              code: "EPERM",
            });
          }
          const handle = await open(...args);
          if (path === cleanupPath && !fixedRemoved) {
            fixedRemoved = true;
            await unlink(fixedPath);
          }
          return handle;
        },
      },
    });
    assert.ok(cleanupChecks >= 2);
    assert.equal(fixedRemoved, true);
    assertWriter(result);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("retries when the matching cleanup artifact itself races away with EPERM", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
    const fixedPath = join(directory, LIFETIME_CLAIM_FILENAME);
    await writeFile(lockPath, lockRecord(999_999), { mode: 0o600 });
    await crashClaimWorker(directory, lockPath, "claim-before-move");
    const recordName = (await readdir(directory)).find((name) =>
      name.startsWith(".sdl-observability-lifetime.claim-record."));
    assert.ok(recordName);
    const nonce = recordName.slice(
      ".sdl-observability-lifetime.claim-record.".length,
      -".json".length,
    );
    const cleanupPath = join(
      directory,
      `.sdl-observability-lifetime.claim-cleanup.${nonce}`,
    );
    let witnessDenied = false;
    let cleanupDenied = false;

    const result = await acquireLifetimeLease(directory, {
      pid: 4242,
      isPidAlive: () => false,
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          const path = String(args[0]);
          if (
            !witnessDenied &&
            basename(path).startsWith(".sdl-observability-lifetime.claim-source.")
          ) {
            witnessDenied = true;
            await link(fixedPath, cleanupPath);
            throw Object.assign(new Error("witness denied during cleanup"), { code: "EPERM" });
          }
          if (path === cleanupPath && !cleanupDenied) {
            cleanupDenied = true;
            await unlink(cleanupPath);
            await unlink(fixedPath);
            throw Object.assign(new Error("cleanup raced away"), { code: "EPERM" });
          }
          return open(...args);
        },
      },
    });
    assert.equal(witnessDenied, true);
    assert.equal(cleanupDenied, true);
    assertWriter(result);
    assert.equal(await releaseLifetimeLease(result.lease), true);
  });

  it("treats EPERM from a concurrently removed claim auxiliary as raced", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = join(directory, "auxiliary-race-source.json");
    const nonce = "7".repeat(32);
    const recordPath = join(
      directory,
      `.sdl-observability-lifetime.claim-record.${nonce}.json`,
    );
    await writeFile(sourcePath, lockRecord(999_999));
    await writeFile(recordPath, claimRecord(999_999, nonce, await fileSnapshot(sourcePath)));
    let raced = false;

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          if (!raced && String(args[0]) === recordPath) {
            raced = true;
            await unlink(recordPath);
            throw Object.assign(new Error("claim record raced away"), { code: "EPERM" });
          }
          return open(...args);
        },
      },
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "contended" });
    const successor = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
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

  it("preserves an exact inode-zero create anchor witness pair fail closed", async () => {
    const directory = await temporaryDirectory();
    const nonce = "6".repeat(32);
    const anchorPath = join(directory, `.sdl-observability-lifetime.create.${nonce}`);
    const witnessPath = join(directory, `.sdl-observability-lifetime.create-source.${nonce}`);
    await writeFile(anchorPath, createAnchorRecord(999_999, nonce), { mode: 0o600 });
    await link(anchorPath, witnessPath);
    const zero = { dev: 0n, ino: 0n };
    const fixture = identityFixtureFileSystem((path) =>
      basename(path).includes(nonce) ? zero : undefined);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
      fileSystem: fixture,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" });
    assert.deepEqual(await auxiliaryFiles(directory), [basename(witnessPath), basename(anchorPath)]);
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
    assert.equal((await auxiliaryFiles(directory)).length, 17);

    const second = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(second.mode, "readOnly");
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
      if (index < 8) {
        await assertMissing(record);
        await assertMissing(witness);
      } else {
        assert.equal((await lstat(record)).isFile(), true);
        assert.equal((await lstat(witness)).isFile(), true);
      }
    }

    for (let batch = 0; batch < 2; batch++) {
      const next = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      assert.equal(next.mode, "readOnly", `batch ${batch + 2}`);
    }
    const successor = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.deepEqual(await auxiliaryFiles(directory), []);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
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

  it("does not retire an exact alias before rejecting an unrelated oversized group", async () => {
    const directory = await temporaryDirectory();
    const aliasNonce = "81".repeat(16);
    const anchorPath = join(
      directory,
      `.sdl-observability-lifetime.create.${aliasNonce}`,
    );
    await writeFile(anchorPath, createAnchorRecord(999_999, aliasNonce, 999_999, ISO_2));
    await link(anchorPath, `${anchorPath}.cleanup`);

    const source = join(directory, "combined-oversized-source.json");
    await writeFile(source, lockRecord(91_100));
    const snapshot = await fileSnapshot(source);
    for (let index = 0; index < 17; index++) {
      const nonce = (index + 200).toString(16).padStart(32, "0");
      await writeFile(
        join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
        claimRecord(999_999, nonce, snapshot, ISO_1),
      );
      await link(source, join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`));
    }
    const before = await auxiliaryContents(directory);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" });
    assert.deepEqual(await auxiliaryContents(directory), before);
  });

  it("does not retire a newer alias group ahead of an older selected group", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "older-budget-source.json");
    await writeFile(source, lockRecord(91_200));
    const snapshot = await fileSnapshot(source);
    let firstRecord = "";
    let firstNonce = "";
    for (let index = 0; index < 7; index++) {
      const nonce = (index + 300).toString(16).padStart(32, "0");
      const content = claimRecord(999_999, nonce, snapshot, ISO_1);
      if (index === 0) {
        firstNonce = nonce;
        firstRecord = content;
      }
      await writeFile(
        join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
        content,
      );
      await link(source, join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`));
    }
    await writeFile(
      join(directory, `.sdl-observability-lifetime.claim-cleanup.${firstNonce}`),
      firstRecord,
    );

    const aliasNonce = "82".repeat(16);
    const anchorPath = join(
      directory,
      `.sdl-observability-lifetime.create.${aliasNonce}`,
    );
    const cleanupPath = `${anchorPath}.cleanup`;
    await writeFile(anchorPath, createAnchorRecord(999_999, aliasNonce, 999_999, ISO_2));
    await link(anchorPath, cleanupPath);
    const aliasBefore = {
      [basename(anchorPath)]: (await readFile(anchorPath)).toString("base64"),
      [basename(cleanupPath)]: (await readFile(cleanupPath)).toString("base64"),
    };

    const first = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(first.mode, "readOnly");
    assert.deepEqual(await auxiliaryContents(directory), aliasBefore);

    const successor = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
  });

  it("counts alias normalization mutations at the cleanup budget boundary", async () => {
    const populateOldNormalizationGroup = async (
      directory: string,
      extraClaimRecords: number,
    ): Promise<void> => {
      const anchorNonce = "b1".repeat(16);
      const anchorName = `.sdl-observability-lifetime.create.${anchorNonce}`;
      await writeExactAuxiliaryAliases(
        directory,
        anchorName,
        [".cleanup", ".cleanup-next"],
        createAnchorRecord(999_999, anchorNonce, 999_999, ISO_1),
      );
      const anchorPath = join(directory, `${anchorName}.cleanup`);
      const snapshot = await fileSnapshot(anchorPath);
      const witnessName = `.sdl-observability-lifetime.create-source.${anchorNonce}`;
      await link(anchorPath, join(directory, witnessName));
      await link(anchorPath, join(directory, `${witnessName}.cleanup`));
      await link(anchorPath, join(directory, `${witnessName}.cleanup-next`));

      for (let index = 0; index < 4; index++) {
        const nonce = (0xc0 + index).toString(16).padStart(32, "0");
        await writeFile(
          join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
          claimRecord(999_999, nonce, snapshot, ISO_1),
        );
        await link(anchorPath, join(directory, `.sdl-observability-lifetime.claim-source.${nonce}`));
      }
      for (let index = 0; index < extraClaimRecords; index++) {
        const nonce = (0xd0 + index).toString(16).padStart(32, "0");
        await writeFile(
          join(directory, `.sdl-observability-lifetime.claim-record.${nonce}.json`),
          claimRecord(999_999, nonce, snapshot, ISO_1),
        );
      }
    };

    const oversizedDirectory = await temporaryDirectory();
    await populateOldNormalizationGroup(oversizedDirectory, 2);
    const oversizedBefore = await auxiliaryContents(oversizedDirectory);
    const oversized = await acquireLifetimeLease(oversizedDirectory, {
      isClaimantPidAlive: () => false,
    });
    assert.deepEqual(oversized, { mode: "readOnly", reason: "invalidLock" });
    assert.deepEqual(await auxiliaryContents(oversizedDirectory), oversizedBefore);

    const boundedDirectory = await temporaryDirectory();
    await populateOldNormalizationGroup(boundedDirectory, 1);
    const newerNonce = "b2".repeat(16);
    const newerName = `.sdl-observability-lifetime.create.${newerNonce}`;
    await writeFile(
      join(boundedDirectory, newerName),
      createAnchorRecord(999_999, newerNonce, 999_999, ISO_2),
    );
    const first = await acquireLifetimeLease(boundedDirectory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(first.mode, "readOnly");
    assert.deepEqual(await auxiliaryFiles(boundedDirectory), [newerName]);

    const successor = await acquireLifetimeLease(boundedDirectory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(boundedDirectory), []);
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
        lstat: async (...args: Parameters<typeof lstat>) => {
          const path = String(args[0]);
          const result = await lstat(...args);
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
        opendir: async (...args: Parameters<typeof opendir>) => {
          const result = await opendir(...args);
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
    for (let iteration = 0; iteration < 6; iteration++) {
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

      assert.equal((await evidenceFiles(directory)).length, 8, `iteration ${iteration}`);
      assert.equal((await lstat(paths[0])).isFile(), true, "protected evidence remains");
      await assert.rejects(lstat(paths[1]), { code: "ENOENT" });
    }
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

  it("retires an exact committed evidence deletion duplicate", async () => {
    const directory = await temporaryDirectory();
    const duplicate = await writeEvidenceDeletionDuplicate(directory, 0);

    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(result);
    assert.equal((await lstat(duplicate.targetPath)).isFile(), true);
    await assertMissing(duplicate.deletePath);
    assert.equal(await releaseLifetimeLease(result.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
  });

  it("recovers evidence deletion retirement interrupted after alias restoration", async () => {
    const directory = await temporaryDirectory();
    const duplicate = await writeEvidenceDeletionDuplicate(directory, 1);
    const candidatePath = join(
      directory,
      normalizationCandidateName(
        duplicate.deleteName,
        duplicate.deleteName,
        duplicate.snapshot,
      ),
    );
    let corruptCandidateRead = true;
    let interrupted = false;

    const first = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
      fileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (!corruptCandidateRead || String(args[0]) !== candidatePath) return handle;
          corruptCandidateRead = false;
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === "read") {
                return async (buffer: Buffer, offset: number, length: number, position: number) => {
                  const result = await target.read(buffer, offset, length, position);
                  if (result.bytesRead > 0) buffer[offset] ^= 1;
                  return result;
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        unlink: async (...args: Parameters<typeof unlink>) => {
          if (!interrupted && String(args[0]) === candidatePath) {
            interrupted = true;
            throw Object.assign(new Error("evidence candidate unlink interrupted"), { code: "EIO" });
          }
          return unlink(...args);
        },
      },
    });
    assert.equal(first.mode, "readOnly");
    assert.equal(interrupted, true);
    assert.equal((await lstat(duplicate.deletePath, { bigint: true })).ino,
      (await lstat(candidatePath, { bigint: true })).ino);

    let successor: Awaited<ReturnType<typeof acquireLifetimeLease>> | undefined;
    for (let startup = 0; startup < 3; startup++) {
      successor = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      if (successor.mode === "writer") break;
    }
    assert.notEqual(successor, undefined);
    assertWriter(successor);
    assert.equal((await lstat(duplicate.targetPath)).isFile(), true);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
  });

  it("preserves mismatched or alternate-exhausted evidence deletion duplicates", async () => {
    for (const state of ["mismatch", "exhausted"] as const) {
      const directory = await temporaryDirectory();
      const duplicate = await writeEvidenceDeletionDuplicate(
        directory,
        state === "mismatch" ? 2 : 3,
      );
      if (state === "mismatch") {
        await unlink(duplicate.deletePath);
        await writeFile(duplicate.deletePath, lockRecord(96_000));
      } else {
        for (let attempt = 0; attempt < 4; attempt++) {
          const candidatePath = join(
            directory,
            normalizationCandidateName(
              duplicate.deleteName,
              duplicate.deleteName,
              duplicate.snapshot,
              attempt,
            ),
          );
          await link(duplicate.deletePath, candidatePath);
        }
      }
      const before = await auxiliaryContents(directory);

      const result = await acquireLifetimeLease(directory, {
        isClaimantPidAlive: () => false,
      });
      assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" }, state);
      assert.deepEqual(await auxiliaryContents(directory), before, state);
    }
  });

  it("budgets exact evidence deletion duplicate retirement as two mutations", async () => {
    const directory = await temporaryDirectory();
    const duplicates = await Promise.all(
      Array.from({ length: 17 }, (_, index) =>
        writeEvidenceDeletionDuplicate(directory, index + 10)),
    );

    const first = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assert.equal(first.mode, "readOnly");
    assert.equal((await auxiliaryFiles(directory)).length, 1);
    for (const duplicate of duplicates.slice(0, 16)) await assertMissing(duplicate.deletePath);
    assert.equal((await lstat(duplicates[16]!.deletePath)).isFile(), true);

    const successor = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
    });
    assertWriter(successor);
    assert.equal(await releaseLifetimeLease(successor.lease), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);
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

  it("validates evidence labels and reserved source names before mutation", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "runtime-label-source.json");
    await writeFile(source, lockRecord(30_100));
    const bogus = {
      kind: "bogus",
      eligibility: "validated-supported",
    } as unknown as LifetimeEvidenceLabel;
    await assert.rejects(rotateLifetimeEvidence(directory, source, bogus), /label/i);
    assert.equal((await lstat(source)).isFile(), true);
    assert.deepEqual(await auxiliaryFiles(directory), []);

    const reserved = join(directory, `.sdl-observability-lifetime.create.${"ab".repeat(16)}`);
    await writeFile(reserved, lockRecord(30_101));
    await assert.rejects(
      rotateLifetimeEvidence(directory, reserved, {
        kind: "lock",
        eligibility: "validated-supported",
      }),
      /reserved|source/i,
    );
    assert.equal((await lstat(reserved)).isFile(), true);
  });

  it("rejects inode-zero evidence replacement identity without moving either path", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "inode-zero-evidence.json");
    const content = lockRecord(30_102);
    await writeFile(source, content);
    const zero = { dev: 0n, ino: 0n };
    const fixture = identityFixtureFileSystem((path) =>
      path === source || basename(path).startsWith(".sdl-observability-lifetime.")
        ? zero
        : undefined);
    const fileSystem = resolveLifetimeFileSystem(fixture);
    const expected = (await readLifetimeSource(source, fileSystem)).snapshot;
    await unlink(source);
    await writeFile(source, content);

    await assert.rejects(
      rotateLifetimeEvidence(
        directory,
        source,
        { kind: "lock", eligibility: "validated-supported" },
        { expectedSource: expected, fileSystem: fixture },
      ),
      /identity|mismatch|unsupported/i,
    );
    assert.equal(await readFile(source, "utf8"), content);
    assert.deepEqual(await evidenceFiles(directory), []);
  });

  it("streams and bounds auxiliary and evidence directory scans", async () => {
    const auxiliaryDirectory = await temporaryDirectory();
    for (let index = 0; index < 257; index++) {
      const nonce = index.toString(16).padStart(32, "0");
      await writeFile(
        join(auxiliaryDirectory, `.sdl-observability-lifetime.create.${nonce}`),
        createAnchorRecord(999_999, nonce),
      );
    }
    let auxiliaryEnumerated = 0;
    let auxiliaryReads = 0;
    const boundedAuxiliaryFs = {
      open: async (...args: Parameters<typeof open>) => {
        if (basename(String(args[0])).startsWith(".sdl-observability-lifetime.")) {
          auxiliaryReads++;
        }
        return open(...args);
      },
      opendir: async (...args: Parameters<typeof opendir>) => {
        const opened = await opendir(...args);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const entry of opened) {
              auxiliaryEnumerated++;
              assert.ok(auxiliaryEnumerated <= 257);
              yield entry;
            }
          },
        } as unknown as Awaited<ReturnType<typeof opendir>>;
      },
    };
    const blocked = await acquireLifetimeLease(auxiliaryDirectory, {
      isClaimantPidAlive: () => false,
      fileSystem: boundedAuxiliaryFs,
    });
    assert.deepEqual(blocked, { mode: "readOnly", reason: "invalidLock" });
    assert.equal(auxiliaryEnumerated, 257);
    assert.equal(auxiliaryReads, 0);

    const evidenceDirectory = await temporaryDirectory();
    for (let index = 0; index < 9; index++) {
      const timestamp = (1_700_000_000_000 + index).toString(36).padStart(11, "0");
      const nonce = (index + 1).toString(16).padStart(32, "0");
      await writeFile(
        join(
          evidenceDirectory,
          `sdl-observability-lifetime.evidence.v1.validated-supported.lock.${timestamp}.${nonce}.json`,
        ),
        lockRecord(31_000 + index),
      );
    }
    const source = join(evidenceDirectory, "bounded-evidence-source.json");
    await writeFile(source, lockRecord(31_100));
    let maximumEvidenceSeenInOnePass = 0;
    let evidenceReads = 0;
    const boundedEvidenceFs = {
      open: async (...args: Parameters<typeof open>) => {
        if (basename(String(args[0])).startsWith("sdl-observability-lifetime.evidence.")) {
          evidenceReads++;
        }
        return open(...args);
      },
      opendir: async (...args: Parameters<typeof opendir>) => {
        const opened = await opendir(...args);
        return {
          async *[Symbol.asyncIterator]() {
            let seen = 0;
            for await (const entry of opened) {
              if (entry.name.startsWith("sdl-observability-lifetime.evidence.")) {
                seen++;
                maximumEvidenceSeenInOnePass = Math.max(maximumEvidenceSeenInOnePass, seen);
                assert.ok(seen <= 9);
              }
              yield entry;
            }
          },
        } as unknown as Awaited<ReturnType<typeof opendir>>;
      },
    };
    const before = await evidenceFiles(evidenceDirectory);
    await assert.rejects(
      rotateLifetimeEvidence(
        evidenceDirectory,
        source,
        { kind: "lock", eligibility: "validated-supported" },
        { fileSystem: boundedEvidenceFs },
      ),
      /evidence|limit/i,
    );
    assert.ok(maximumEvidenceSeenInOnePass > 0);
    assert.equal(evidenceReads, 0);
    assert.deepEqual(await evidenceFiles(evidenceDirectory), before);
    assert.equal((await lstat(source)).isFile(), true);
  });

  it("preserves inode-zero startup auxiliaries fail closed", async () => {
    const directory = await temporaryDirectory();
    const nonce = "ac".repeat(16);
    const anchor = join(directory, `.sdl-observability-lifetime.create.${nonce}`);
    const content = createAnchorRecord(999_999, nonce);
    await writeFile(anchor, content);
    const zero = { dev: 0n, ino: 0n };
    const fixture = identityFixtureFileSystem((path) =>
      basename(path).startsWith(".sdl-observability-lifetime.") ? zero : undefined);
    const result = await acquireLifetimeLease(directory, {
      isClaimantPidAlive: () => false,
      fileSystem: fixture,
    });
    assert.deepEqual(result, { mode: "readOnly", reason: "invalidLock" });
    assert.equal(await readFile(anchor, "utf8"), content);
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

  it("distinguishes malformed locks from operational lock read failures", async () => {
    const malformedDirectory = await temporaryDirectory();
    await writeFile(join(malformedDirectory, LIFETIME_LOCK_FILENAME), "not json");
    assert.deepEqual(await acquireLifetimeLease(malformedDirectory), {
      mode: "readOnly",
      reason: "invalidLock",
    });

    for (const code of ["EACCES", "EIO"] as const) {
      const directory = await temporaryDirectory();
      const lockPath = join(directory, LIFETIME_LOCK_FILENAME);
      await writeFile(lockPath, lockRecord(4242));
      const result = await acquireLifetimeLease(directory, {
        fileSystem: {
          open: async (...args: Parameters<typeof open>) => {
            if (String(args[0]) === lockPath && typeof args[1] === "number") {
              throw Object.assign(new Error(`lock read ${code}`), { code });
            }
            return open(...args);
          },
        },
      });
      assert.deepEqual(result, { mode: "readOnly", reason: "ioFailure" });
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

  it("preserves a same-content replacement whose bigint inode differs above 2^53", async () => {
    const directory = await temporaryDirectory();
    const result = await acquireLifetimeLease(directory, { pid: 4242 });
    assertWriter(result);
    const content = await readFile(result.lease.lockPath, "utf8");
    const replacementPath = join(directory, "high-bit-release-replacement.json");
    await writeFile(replacementPath, content, { mode: 0o600 });
    const low = { dev: 9_007_199_254_740_992n, ino: 9_007_199_254_740_992n };
    const high = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_993n };
    assert.equal(Number(low.ino), Number(high.ino));
    let replaced = false;
    const base = identityFixtureFileSystem((path) => {
      const name = basename(path);
      if (name.startsWith(".sdl-observability-lifetime.claim-source.")) return low;
      if (name.startsWith(".sdl-observability-lifetime.release.")) return high;
      if (path === result.lease.lockPath) return replaced ? high : low;
      return undefined;
    });

    const released = await releaseLifetimeLease(result.lease, {
      fileSystem: {
        ...base,
        rename: async (source: string, target: string) => {
          if (source === result.lease.lockPath && !replaced) {
            replaced = true;
            await rename(replacementPath, result.lease.lockPath);
          }
          return rename(source, target);
        },
      },
    });
    assert.equal(released, false);
    assert.equal(replaced, true);
    assert.equal(await readFile(result.lease.lockPath, "utf8"), content);
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

  it("binds operations to one canonical stable trusted directory identity", async (t) => {
    const realParent = await temporaryDirectory();
    const realDirectory = join(realParent, "real", "child");
    await mkdir(realDirectory, { recursive: true });
    const aliasParent = join(realParent, "alias");
    try {
      await symlink(join(realParent, "real"), aliasParent, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.diagnostic("junction creation requires privileges; injected identity case still ran");
      } else {
        throw error;
      }
    }
    try {
      await lstat(aliasParent);
      const viaAncestorAlias = await acquireLifetimeLease(join(aliasParent, "child"));
      assert.deepEqual(viaAncestorAlias, { mode: "readOnly", reason: "invalidLock" });
      await assert.rejects(lstat(join(realDirectory, LIFETIME_LOCK_FILENAME)), { code: "ENOENT" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const source = join(realDirectory, "directory-identity-source.json");
    await writeFile(source, lockRecord(32_000));
    const first = { dev: 91n, ino: 92n };
    const second = { dev: 91n, ino: 93n };
    let directoryIdentityReads = 0;
    const result = rotateLifetimeEvidence(
      realDirectory,
      source,
      { kind: "lock", eligibility: "validated-supported" },
      {
        fileSystem: {
          realpath,
          lstat: async (...args: Parameters<typeof lstat>) => {
            const stat = await lstat(...args);
            if (String(args[0]) !== realDirectory) return stat;
            directoryIdentityReads++;
            return identityStat(stat, directoryIdentityReads <= 2 ? first : second);
          },
        },
      },
    );
    await assert.rejects(result, /directory|identity|changed/i);
    assert.equal((await lstat(source)).isFile(), true);
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

  it("bounds child protocol waits and forcibly cleans up a stalled worker", async () => {
    const directory = await temporaryDirectory();
    const worker = await spawnWorker(directory);
    assert.deepEqual(await worker.next(), { event: "acquired", mode: "writer" });
    await assert.rejects(worker.next(25), /timed out/);
    await worker.exited;
    assert.equal(worker.child.killed, true);
  });
});
