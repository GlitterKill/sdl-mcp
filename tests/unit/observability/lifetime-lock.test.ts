import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, it } from "node:test";

import {
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

async function spawnWorker(directory: string) {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "tests/fixtures/observability-lifetime-lock-worker.mjs"), directory],
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
      if (code === 0) resolve();
      else reject(new Error(`lock worker exited ${code}: ${child.stderr.read() ?? ""}`));
    });
  });
  return { child, next, send, exited };
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
          if (args[1] === "wx") exclusiveCreates++;
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
      /regular non-symlink evidence/i,
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
      /regular non-symlink evidence/i,
    );
    assert.equal((await lstat(evidenceSource)).isFile(), true);
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
    secondary.send("state");
    assert.deepEqual(await secondary.next(), { event: "state", mode: "readOnly" });

    const successor = await spawnWorker(directory);
    assert.deepEqual(await successor.next(), { event: "acquired", mode: "writer" });
    successor.send("release");
    assert.deepEqual(await successor.next(), { event: "released", released: true });
    await successor.exited;
    secondary.send("exit");
    await secondary.exited;
  });
});
