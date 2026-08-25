import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { computeDelta } from "../../dist/delta/diff.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import { handleDeltaGet } from "../../dist/mcp/tools/delta.js";

const REPO_ID = "delta-paging-contract";
const PAGE_SIZE = 3;

type DeltaChange = {
  symbolId: string;
  changeType: "added" | "modified" | "removed";
};

type DeltaPage = {
  delta: {
    fromVersion: string;
    toVersion: string;
    changedSymbols: DeltaChange[];
    mode?: "preview";
    totalChanges?: number;
    sampleSize?: number;
    blastRadius?: unknown[];
    trimmedSet?: unknown;
    truncation?: unknown;
  };
  hint?: string;
  cursor?: {
    fromVersion: string;
    toVersion: string;
    offset: number;
  };
  hasMore?: true;
  nextAction?: {
    action: string;
    args: Record<string, unknown>;
  };
};

describe("delta paging contract", () => {
  let dbPath = "";
  let configPath = "";
  let priorConfig: string | undefined;

  let timestamp = Date.parse("2026-01-01T00:00:00.000Z");

  async function seedVersion(
    versionId: string,
    symbols: readonly string[],
  ): Promise<void> {
    const conn = await getLadybugConn();
    timestamp += 1_000;
    const created = new Date(timestamp).toISOString();
    await ladybugDb.createVersion(conn, {
      versionId,
      repoId: REPO_ID,
      createdAt: created,
      reason: "delta paging fixture",
      prevVersionHash: null,
      versionHash: versionId,
    });
    for (const symbolId of symbols) {
      await ladybugDb.snapshotSymbolVersion(conn, {
        versionId,
        symbolId,
        astFingerprint: `fingerprint:${symbolId}`,
        signatureJson: "{}",
        summary: symbolId,
        invariantsJson: null,
        sideEffectsJson: null,
        testCaseJson: null,
      });
    }
  }

  async function seedPair(
    name: string,
    addedSymbols: readonly string[],
  ): Promise<{ fromVersion: string; toVersion: string }> {
    const fromVersion = `${name}-from`;
    const toVersion = `${name}-to`;
    await seedVersion(fromVersion, ["anchor"]);
    await seedVersion(toVersion, ["anchor", ...addedSymbols]);
    return { fromVersion, toVersion };
  }

  async function getPage(
    versions: { fromVersion?: string; toVersion?: string },
    cursor?: DeltaPage["cursor"],
  ): Promise<DeltaPage> {
    return (await handleDeltaGet({
      repoId: REPO_ID,
      ...versions,
      ...(cursor ? { cursor } : {}),
      budget: { maxCards: PAGE_SIZE, maxEstimatedTokens: 4_000 },
      skipBlastRadius: true,
    })) as DeltaPage;
  }

  async function exhaust(
    versions: { fromVersion?: string; toVersion?: string },
  ): Promise<{ pages: DeltaPage[]; changes: DeltaChange[] }> {
    const pages: DeltaPage[] = [];
    const changes: DeltaChange[] = [];
    let page = await getPage(versions);

    while (true) {
      pages.push(page);
      changes.push(...page.delta.changedSymbols);
      if (!page.nextAction) break;

      assert.equal(page.hasMore, true);
      assert.deepEqual(page.cursor, page.nextAction.args.cursor);
      assert.equal(page.nextAction.action, "sdl.delta.get");
      assert.equal(page.nextAction.args.repoId, REPO_ID);
      assert.equal(page.nextAction.args.fromVersion, page.delta.fromVersion);
      assert.equal(page.nextAction.args.toVersion, page.delta.toVersion);
      assert.deepEqual(page.nextAction.args.budget, {
        maxCards: PAGE_SIZE,
        maxEstimatedTokens: 4_000,
      });
      assert.equal(page.nextAction.args.skipBlastRadius, true);

      page = await getPage(
        {
          fromVersion: page.nextAction.args.fromVersion as string,
          toVersion: page.nextAction.args.toVersion as string,
        },
        page.nextAction.args.cursor as DeltaPage["cursor"],
      );
    }

    const finalPage = pages.at(-1)!;
    assert.equal("cursor" in finalPage, false);
    assert.equal("hasMore" in finalPage, false);
    assert.equal("nextAction" in finalPage, false);
    return { pages, changes };
  }

  before(async () => {
    dbPath = mkdtempSync(join(tmpdir(), "sdl-delta-paging-"));
    configPath = join(dbPath, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [],
        policy: {},
        indexing: { engine: "typescript", enableFileWatching: false },
        semanticEnrichment: { enabled: false },
        scip: { enabled: false },
      }),
      "utf8",
    );
    priorConfig = process.env.SDL_CONFIG;
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
    await closeLadybugDb();
    await initLadybugDb(join(dbPath, "graph.lbug"));
  });

  after(async () => {
    await closeLadybugDb();
    if (priorConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = priorConfig;
    invalidateConfigCache();
    rmSync(dbPath, { recursive: true, force: true });
  });

  it("covers zero, one, exactly maxCards, and maxCards plus one deterministically", async () => {
    const zero = await seedPair("zero", []);
    const one = await seedPair("one", ["symbol-one"]);
    const exact = await seedPair("exact", ["symbol-c", "symbol-a", "symbol-b"]);
    const overflow = await seedPair("overflow", [
      "symbol-d",
      "symbol-b",
      "symbol-a",
      "symbol-c",
    ]);

    for (const [versions, expectedCount] of [
      [zero, 0],
      [one, 1],
      [exact, PAGE_SIZE],
      [overflow, PAGE_SIZE + 1],
    ] as const) {
      const first = await exhaust(versions);
      const repeated = await exhaust(versions);
      const canonical = await computeDelta(
        REPO_ID,
        versions.fromVersion,
        versions.toVersion,
      );

      assert.equal(first.changes.length, expectedCount);
      const canonicalPublicOrder = canonical.changedSymbols.slice().sort(
        (left, right) =>
          left.symbolId < right.symbolId
            ? -1
            : left.symbolId > right.symbolId
              ? 1
              : 0,
      );
      assert.deepEqual(first.changes, canonicalPublicOrder);
      assert.deepEqual(repeated, first);
      assert.equal(
        new Set(first.changes.map((change) => change.symbolId)).size,
        expectedCount,
      );
    }
  });

  it("returns a bounded preview with complete metadata and no blast radius", async () => {
    const versions = await seedPair("preview", [
      "symbol-c",
      "symbol-a",
      "symbol-b",
    ]);

    const preview = (await handleDeltaGet({
      repoId: REPO_ID,
      ...versions,
      preview: true,
      previewSampleSize: 2,
    })) as DeltaPage;

    assert.equal(preview.delta.mode, "preview");
    assert.equal(preview.delta.totalChanges, 3);
    assert.equal(preview.delta.sampleSize, 2);
    assert.deepEqual(
      preview.delta.changedSymbols.map(({ symbolId }) => symbolId),
      ["symbol-a", "symbol-b"],
    );
    assert.deepEqual(preview.delta.blastRadius, []);
  });

  it("returns the same-version handler hint with deterministic empty ordering", async () => {
    const versionId = "same-version";
    await seedVersion(versionId, ["anchor"]);
    const versions = { fromVersion: versionId, toVersion: versionId };

    const first = await getPage(versions);
    const second = await getPage(versions);

    assert.deepEqual(second, first);
    assert.deepEqual(first.delta.changedSymbols, []);
    assert.equal(
      first.hint,
      "Only one ledger version exists — delta is empty. Run index.refresh after making changes to create a new version.",
    );
  });

  it("materializes resolved defaults in the response and continuation", async () => {
    const defaults = await seedPair("zz-defaults", [
      "symbol-4",
      "symbol-2",
      "symbol-3",
      "symbol-1",
    ]);
    const first = await getPage({});

    assert.equal(first.delta.fromVersion, defaults.fromVersion);
    assert.equal(first.delta.toVersion, defaults.toVersion);
    assert.deepEqual(first.cursor, {
      fromVersion: defaults.fromVersion,
      toVersion: defaults.toVersion,
      offset: PAGE_SIZE,
    });
    assert.equal(first.nextAction?.args.fromVersion, defaults.fromVersion);
    assert.equal(first.nextAction?.args.toVersion, defaults.toVersion);
  });

  it("resolves omitted partial-budget fields with delta-specific defaults", async () => {
    const versions = await seedPair(
      "partial-budget",
      Array.from({ length: 11 }, (_, index) => `symbol-${index + 1}`),
    );

    const tokenOnly = (await handleDeltaGet({
      repoId: REPO_ID,
      ...versions,
      budget: { maxEstimatedTokens: 4_000 },
      skipBlastRadius: true,
    })) as DeltaPage;
    assert.equal(tokenOnly.delta.changedSymbols.length, 10);
    assert.deepEqual(tokenOnly.cursor, {
      ...versions,
      offset: 10,
    });
    assert.deepEqual(tokenOnly.nextAction?.args.budget, {
      maxCards: 10,
      maxEstimatedTokens: 4_000,
    });

    const cardsOnly = (await handleDeltaGet({
      repoId: REPO_ID,
      ...versions,
      budget: { maxCards: PAGE_SIZE },
      skipBlastRadius: true,
    })) as DeltaPage;
    assert.equal(cardsOnly.delta.changedSymbols.length, PAGE_SIZE);
    assert.deepEqual(cardsOnly.nextAction?.args.budget, {
      maxCards: PAGE_SIZE,
      maxEstimatedTokens: 4_000,
    });
  });

  it("rejects a version-mismatched cursor with a stable code", async () => {
    const versions = await seedPair("mismatch", [
      "symbol-1",
      "symbol-2",
      "symbol-3",
      "symbol-4",
    ]);
    const first = await getPage(versions);
    assert.ok(first.cursor);

    await assert.rejects(
      () =>
        getPage(
          { fromVersion: versions.fromVersion, toVersion: "other-version" },
          first.cursor,
        ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "DELTA_CURSOR_MISMATCH",
    );
  });

  it("omits empty/default delta detail only from compact zero-change output", async () => {
    const versions = await seedPair("compact-zero", []);
    const canonical = await getPage(versions);
    const detailedCanonical = {
      ...canonical,
      delta: {
        ...canonical.delta,
        blastRadius: [],
        trimmedSet: {
          trimmed: false,
          keptSymbols: [],
          droppedSymbols: [],
          spilloverHandle: null,
        },
        truncation: {
          truncated: false,
          droppedChanges: 0,
          droppedBlastRadius: 0,
          howToResume: null,
        },
      },
    };
    const compact = projectToolResultForModelContent(
      "sdl.delta.get",
      detailedCanonical,
      { detail: "compact" },
    ) as { delta: Record<string, unknown> };

    assert.equal("blastRadius" in compact.delta, false);
    assert.equal("trimmedSet" in compact.delta, false);
    assert.equal("truncation" in compact.delta, false);

    const compactNonEmptyDetail = projectToolResultForModelContent(
      "sdl.delta.get",
      {
        ...detailedCanonical,
        delta: {
          ...detailedCanonical.delta,
          blastRadius: [{ symbolId: "impacted", distance: 1 }],
          trimmedSet: {
            trimmed: true,
            keptSymbols: ["impacted"],
            droppedSymbols: [],
            spilloverHandle: null,
          },
          truncation: {
            truncated: true,
            droppedChanges: 1,
            droppedBlastRadius: 1,
            howToResume: { type: "cursor", value: 11 },
          },
        },
      },
      { detail: "compact" },
    ) as { delta: Record<string, unknown> };
    assert.deepEqual(compactNonEmptyDetail.delta.blastRadius, [
      { symbolId: "impacted", distance: 1 },
    ]);
    assert.equal(
      (compactNonEmptyDetail.delta.trimmedSet as { trimmed: boolean }).trimmed,
      true,
    );
    assert.equal(
      (compactNonEmptyDetail.delta.truncation as { truncated: boolean })
        .truncated,
      true,
    );

    for (const detail of ["standard", "full"] as const) {
      const restored = projectToolResultForModelContent(
        "sdl.delta.get",
        detailedCanonical,
        { detail },
      ) as { delta: Record<string, unknown> };
      assert.deepEqual(restored.delta.blastRadius, [], detail);
      assert.deepEqual(
        restored.delta.trimmedSet,
        detailedCanonical.delta.trimmedSet,
        detail,
      );
      assert.deepEqual(
        restored.delta.truncation,
        detailedCanonical.delta.truncation,
        detail,
      );
    }
  });
});
