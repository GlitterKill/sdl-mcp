import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import * as derivedState from "../../dist/db/ladybug-derived-state.js";

const integrityModule = await import(
  "../../dist/indexer/provider-first/persisted-graph-integrity.js"
).catch(() => null);

type IntegrityModule = Record<string, unknown>;
type AsyncFn = (...args: unknown[]) => Promise<unknown>;
type SyncFn = (...args: unknown[]) => unknown;

function requiredFunction<T extends AsyncFn | SyncFn>(
  source: IntegrityModule | typeof derivedState | null,
  name: string,
): T {
  const candidate = source?.[name as keyof typeof source];
  assert.equal(typeof candidate, "function", `${name} must be implemented`);
  return candidate as T;
}

function symbolRow(overrides: Record<string, unknown> = {}) {
  return {
    symbolId: "sym:alpha",
    repoId: "repo",
    fileId: "repo:src/alpha.ts",
    kind: "function",
    name: "alpha",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: "fingerprint-alpha",
    signatureJson: '{"name":"alpha"}',
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    source: "scip",
    scipSymbol: "scip-typescript npm fixture 1.0.0 src/alpha.ts/alpha().",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("persisted graph integrity", () => {
  let root = "";

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
  });

  it("builds the same canonical digest regardless of authoritative row order", () => {
    const createFileDigest = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityFileDigest",
    );
    const createExpectation = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityExpectation",
    );
    const first = symbolRow();
    const second = symbolRow({
      symbolId: "sym:beta",
      name: "beta",
      astFingerprint: "fingerprint-beta",
      signatureJson: '{"name":"beta"}',
      scipSymbol: "scip-typescript npm fixture 1.0.0 src/alpha.ts/beta().",
    });

    const forwardFile = createFileDigest({
      fileId: first.fileId,
      relPath: "src/alpha.ts",
      symbols: [first, second],
    });
    const reverseFile = createFileDigest({
      fileId: first.fileId,
      relPath: "src/alpha.ts",
      symbols: [second, first],
    });

    assert.deepEqual(
      createExpectation([forwardFile]),
      createExpectation([reverseFile]),
    );
  });

  it("commits every established immutable provider canonical field", () => {
    const createFileDigest = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityFileDigest",
    );
    const base = symbolRow({
      symbolStatus: "real",
      external: false,
      placeholderKind: "",
      placeholderTarget: "",
    });
    const digest = (row: ReturnType<typeof symbolRow>) =>
      createFileDigest({
        fileId: String(row.fileId),
        relPath: "src/alpha.ts",
        symbols: [row],
      }) as { digest: string };
    const baseline = digest(base).digest;
    const changes: Array<[string, unknown]> = [
      ["symbolStatus", "external"],
      ["external", true],
      ["placeholderKind", "provider-metadata"],
      ["placeholderTarget", "sym:target"],
    ];

    for (const [field, value] of changes) {
      assert.notEqual(
        digest(symbolRow({ ...base, [field]: value })).digest,
        baseline,
        `${field} must participate in the canonical digest`,
      );
    }
    assert.equal(
      digest(symbolRow({ ...base, summarySource: "post-write-llm" })).digest,
      baseline,
      "summarySource is intentionally excluded because semantic refresh mutates it",
    );
  });

  it("derives legacy expectations before either persistence path starts", () => {
    for (const [relativePath, persistenceMarker] of [
      ["src/indexer/parser/process-file.ts", "if (batchAccumulator)"],
      ["src/indexer/parser/rust-process-file.ts", "if (params.batchAccumulator)"],
    ] as const) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      const digestIndex = source.indexOf(
        "const graphIntegrityFile = createGraphIntegrityFileDigest",
      );
      const persistenceIndex = source.indexOf(persistenceMarker);

      assert.ok(digestIndex >= 0, `${relativePath} must derive a compact digest`);
      assert.ok(
        digestIndex < persistenceIndex,
        `${relativePath} must derive its digest before persistence begins`,
      );
    }
  });

  it("does not auto-fallback after persisted integrity verification fails", () => {
    const source = readFileSync(
      join(process.cwd(), "src/indexer/indexer.ts"),
      "utf8",
    );

    assert.match(
      source,
      /err instanceof ProviderFirstGraphValidationError\s*\|\|\s*err instanceof GraphIntegrityVerificationError/,
    );
  });

  it("keeps mismatch diagnostics deterministic and bounded", () => {
    const createFileDigest = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityFileDigest",
    );
    const createExpectation = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityExpectation",
    );
    const compare = requiredFunction<SyncFn>(
      integrityModule,
      "compareGraphIntegrityExpectations",
    );
    const longValue = "x".repeat(4_096);
    const expected = createExpectation([
      createFileDigest({
        fileId: `repo:${longValue}`,
        relPath: `src/${longValue}.ts`,
        symbols: [symbolRow({ fileId: `repo:${longValue}` })],
      }),
    ]);
    const actual = createExpectation([
      createFileDigest({
        fileId: `repo:${longValue}`,
        relPath: `src/${longValue}.ts`,
        symbols: [symbolRow({
          fileId: `repo:${longValue}`,
          signatureJson: '{"name":"changed"}',
        })],
      }),
    ]);

    const first = compare(expected, actual);
    const second = compare(expected, actual);
    const serialized = JSON.stringify(first);

    assert.deepEqual(first, second);
    assert.ok(first, "a changed canonical tuple must mismatch");
    assert.ok(serialized.length <= 2_048, serialized);
    assert.doesNotMatch(serialized, new RegExp(longValue));
  });

  it("persists verifying, verified, and failed transitions", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-state-"));
    await initLadybugDb(join(root, "state.lbug"));
    const markVerifying = requiredFunction<AsyncFn>(
      derivedState,
      "markGraphIntegrityVerifying",
    );
    const markVerified = requiredFunction<AsyncFn>(
      derivedState,
      "markGraphIntegrityVerified",
    );
    const markFailed = requiredFunction<AsyncFn>(
      derivedState,
      "markGraphIntegrityFailed",
    );

    await markVerifying("repo", "v1");
    let row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verifying");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(row?.graphIntegrityDigest, null);
    assert.equal(row?.graphIntegrityError, null);

    await markVerified("repo", "v1", "a".repeat(64));
    row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "verified");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(row?.graphIntegrityDigest, "a".repeat(64));
    assert.equal(row?.graphIntegrityError, null);

    await markFailed("repo", "v2", "sensitive ".repeat(300));
    row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "failed");
    assert.equal(row?.graphIntegrityVersionId, "v2");
    assert.equal(row?.graphIntegrityDigest, null);
    assert.ok((row?.graphIntegrityError?.length ?? 0) <= 1_024);
  });

  it("normalizes legacy persistence defaults identically on both sides", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-defaults-"));
    await initLadybugDb(join(root, "defaults.lbug"));
    const createFileDigest = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityFileDigest",
    );
    const createExpectation = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityExpectation",
    );
    const capture = requiredFunction<AsyncFn>(
      integrityModule,
      "capturePersistedGraphIntegrity",
    );
    const compare = requiredFunction<SyncFn>(
      integrityModule,
      "compareGraphIntegrityExpectations",
    );
    const expectedRow = symbolRow({
      source: undefined,
      summarySource: undefined,
      symbolStatus: undefined,
      external: undefined,
      placeholderKind: undefined,
      placeholderTarget: undefined,
    });
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [expectedRow]);
    });

    const actual = await capture(await getLadybugConn(), "repo");
    assert.equal(compare(expected, actual), null);
  });

  it("fails verification and records failed state on a persisted tuple mismatch", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-mismatch-"));
    await initLadybugDb(join(root, "mismatch.lbug"));
    const createFileDigest = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityFileDigest",
    );
    const createExpectation = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityExpectation",
    );
    const complete = requiredFunction<AsyncFn>(
      integrityModule,
      "completeGraphIntegrityVerification",
    );
    const markVerifying = requiredFunction<AsyncFn>(
      derivedState,
      "markGraphIntegrityVerifying",
    );
    const expectedRow = symbolRow();
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [
        symbolRow({ signatureJson: '{"name":"corrupted"}' }),
      ]);
    });
    await markVerifying("repo", "v1");

    await assert.rejects(
      complete("repo", "v1", expected),
      /^Error: Persisted graph integrity verification failed$/,
    );
    const row = await derivedState.getDerivedState("repo");
    assert.equal(row?.graphIntegrityState, "failed");
    assert.equal(row?.graphIntegrityVersionId, "v1");
    assert.equal(
      row?.graphIntegrityError,
      "Persisted graph integrity verification failed",
    );
  });

  it("keeps the public error generic when recording failed state also rejects", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-state-error-"));
    await initLadybugDb(join(root, "state-error.lbug"));
    const createFileDigest = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityFileDigest",
    );
    const createExpectation = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityExpectation",
    );
    const complete = requiredFunction<AsyncFn>(
      integrityModule,
      "completeGraphIntegrityVerification",
    );
    const expectedRow = symbolRow();
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [
        symbolRow({ signatureJson: '{"name":"corrupted"}' }),
      ]);
    });

    let stateWriteAttempted = false;
    await assert.rejects(
      () =>
        complete("repo", "v1", expected, {
          persistFailureState: async () => {
            stateWriteAttempted = true;
            throw new Error("sensitive failure-state write error");
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Persisted graph integrity verification failed",
    );
    assert.equal(stateWriteAttempted, true);
  });

  it("publishes verification under the writer boundary so invalidation wins", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-publish-race-"));
    await initLadybugDb(join(root, "publish-race.lbug"));
    const createFileDigest = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityFileDigest",
    );
    const createExpectation = requiredFunction<SyncFn>(
      integrityModule,
      "createGraphIntegrityExpectation",
    );
    const complete = requiredFunction<AsyncFn>(
      integrityModule,
      "completeGraphIntegrityVerification",
    );
    const markVerifying = requiredFunction<AsyncFn>(
      derivedState,
      "markGraphIntegrityVerifying",
    );
    const invalidate = requiredFunction<AsyncFn>(
      derivedState,
      "invalidateGraphIntegrity",
    );
    const expectedRow = symbolRow({ source: undefined });
    const expected = createExpectation([
      createFileDigest({
        fileId: expectedRow.fileId,
        relPath: "src/alpha.ts",
        symbols: [expectedRow],
      }),
    ]);

    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: expectedRow.fileId,
        repoId: "repo",
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-16T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [expectedRow]);
    });
    await markVerifying("repo", "v1");

    let captureReachedResolve!: () => void;
    const captureReached = new Promise<void>((resolve) => {
      captureReachedResolve = resolve;
    });
    let releasePublishResolve!: () => void;
    const releasePublish = new Promise<void>((resolve) => {
      releasePublishResolve = resolve;
    });
    const verification = complete("repo", "v1", expected, {
      afterCapture: async () => {
        captureReachedResolve();
        await releasePublish;
      },
    });
    const firstPhase = await Promise.race([
      captureReached.then(() => "captured" as const),
      verification.then(() => "published" as const),
    ]);
    assert.equal(firstPhase, "captured");

    await withWriteConn((conn) =>
      ladybugDb.withTransaction(conn, (txConn) =>
        invalidate(txConn, "repo"),
      ),
    );
    releasePublishResolve();
    await assert.rejects(
      verification,
      /^Error: Persisted graph integrity verification failed$/,
    );

    const row = await derivedState.getDerivedState("repo");
    assert.notEqual(row?.graphIntegrityState, "verified");
    assert.equal(row?.graphIntegrityDigest, null);
  });

  it("requires verified integrity for the latest graph version", () => {
    const isVerified = requiredFunction<SyncFn>(
      derivedState,
      "graphIntegrityIsVerifiedForVersion",
    );
    const base = {
      repoId: "repo",
      clustersDirty: false,
      processesDirty: false,
      algorithmsDirty: false,
      summariesDirty: false,
      embeddingsDirty: false,
      targetVersionId: "v2",
      computedVersionId: "v2",
      updatedAt: null,
      lastError: null,
      graphIntegrityVersionId: "v2",
      graphIntegrityDigest: "a".repeat(64),
      graphIntegrityError: null,
    };

    assert.equal(
      isVerified({ ...base, graphIntegrityState: "unknown" }, "v2"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "verifying" }, "v2"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "failed" }, "v2"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "verified" }, "v3"),
      false,
    );
    assert.equal(
      isVerified({ ...base, graphIntegrityState: "verified" }, "v2"),
      true,
    );
  });
});
