import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { queryStoredProcAll } from "../../dist/db/ladybug-core.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { getDerivedState } from "../../dist/db/ladybug-derived-state.js";
import { createVectorIndex } from "../../dist/retrieval/index-lifecycle.js";
import {
  materializeProviderFacts,
  providerFactsToGraphRows,
} from "../../dist/indexer/provider-first/materializer.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import { detectTypeScriptTestCases } from "../../dist/indexer/typescript-test-cases.js";

const REPO_ID = "provider-first-scip-execution";
const NOW = "2026-05-25T12:00:00.000Z";

describe("provider-first SCIP materialization", () => {
  let graphDbPath = "";

  afterEach(async () => {
    await closeLadybugDb();
    if (graphDbPath) rmSync(graphDbPath + ".sdl-lineage.json", { recursive: true, force: true });
    if (graphDbPath && existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    graphDbPath = "";
  });

  it("materializes SCIP files, symbols, external symbols, ranges, and syntax-proved edges", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);

    const main = "scip-typescript npm fixture 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm fixture 1.0.0 src/index.ts/helper().";
    const external = "scip-typescript npm dep 1.0.0 dep/index.ts/api().";
    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-1",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      confidence: 0.95,
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return helper();",
            "}",
            "",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 9, endLine: 2, endCol: 12 },
              symbol: external,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 5, startCol: 16, endLine: 5, endCol: 22 },
              enclosingRange: {
                startLine: 5,
                startCol: 0,
                endLine: 7,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              kind: 12,
              displayName: "main",
              relationships: [{ symbol: external, isDefinition: true }],
            },
            {
              symbol: helper,
              documentation: [],
              kind: 12,
              displayName: "helper",
              relationships: [],
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: external,
          kind: 12,
          displayName: "api",
          documentation: ["External API."],
        },
      ],
    });

    await materializeFacts(facts);

    const conn = await getLadybugConn();
    const mainRow = await ladybugDb.querySingle<{
      rangeStartLine: unknown;
      rangeEndLine: unknown;
      source: string;
    }>(
      conn,
      `MATCH (s:Symbol {name: 'main'})
       RETURN s.rangeStartLine AS rangeStartLine,
              s.rangeEndLine AS rangeEndLine,
              s.source AS source`,
      {},
    );
    assert.equal(ladybugDb.toNumber(mainRow?.rangeStartLine), 1);
    assert.equal(ladybugDb.toNumber(mainRow?.rangeEndLine), 4);
    assert.equal(mainRow?.source, "scip");

    const edgeRows = await ladybugDb.queryAll<{
      fromName: string;
      toName: string;
      edgeType: string;
      resolution: string;
    }>(
      conn,
      `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
       WHERE a.repoId = $repoId
       RETURN a.name AS fromName,
              b.name AS toName,
              d.edgeType AS edgeType,
              d.resolution AS resolution
       ORDER BY toName`,
      { repoId: REPO_ID },
    );
    assert.deepEqual(edgeRows, [
      {
        fromName: "main",
        toName: "api",
        edgeType: "import",
        resolution: "exact",
      },
      {
        fromName: "main",
        toName: "helper",
        edgeType: "call",
        resolution: "exact",
      },
    ]);
  });

  it("persists normalized semantic test cases through the real DB path", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);

    const relPath = "src/embedded-cases.ts";
    const content = readFileSync(
      join(
        process.cwd(),
        "tests",
        "fixtures",
        "semantic-test-cases",
        "sample.test.ts",
      ),
      "utf8",
    );
    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-test-cases",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      sourceTextByPath: new Map([[relPath, content]]),
      documents: [
        {
          language: "typescript",
          relativePath: relPath,
          occurrences: [],
          symbols: [],
        },
      ],
      externalSymbols: [],
    });
    const candidates = detectTypeScriptTestCases({ content, filePath: relPath });
    await materializeFacts(facts, new Map([[relPath, candidates]]));

    const conn = await getLadybugConn();
    const cases = await ladybugDb.queryAll<{
      astFingerprint: string;
      scipSymbol: string | null;
      source: string;
      testCaseJson: string;
    }>(
      conn,
      `MATCH (s:Symbol)
       WHERE s.repoId = $repoId AND s.testCaseJson IS NOT NULL
       RETURN s.astFingerprint AS astFingerprint,
              s.scipSymbol AS scipSymbol,
              s.source AS source,
              s.testCaseJson AS testCaseJson
       ORDER BY s.rangeStartLine, s.rangeStartCol`,
      { repoId: REPO_ID },
    );
    assert.equal(cases.length, 2);
    assert.ok(cases.every((testCase) => testCase.astFingerprint.length > 0));
    assert.ok(cases.every((testCase) => testCase.scipSymbol === null));
    assert.ok(cases.every((testCase) => testCase.source === "treesitter"));
    assert.ok(
      cases.every(
        (testCase) =>
          JSON.parse(testCase.testCaseJson).framework ===
          candidates[0]?.testCase.framework,
      ),
    );
  });

  it("prunes stale SCIP external symbols during a full provider materialization", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);

    const first = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-1",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [documentForExternal("api")],
      externalSymbols: [externalSymbol("api")],
    });
    await materializeFacts(first);

    const second = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-2",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [documentForExternal("replacement")],
      externalSymbols: [externalSymbol("replacement")],
    });
    await materializeFacts(second);

    const conn = await getLadybugConn();
    const externalRows = await ladybugDb.queryAll<{ name: string }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = true AND s.source = 'scip'
       RETURN s.name AS name
       ORDER BY name`,
      { repoId: REPO_ID },
    );
    assert.deepEqual(externalRows, [{ name: "replacement" }]);
  });

  it("prunes stale SCIP external vectors while retaining the live HNSW", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);

    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-vector-prune",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [documentForExternals(["api", "replacement"])],
      externalSymbols: [externalSymbol("api"), externalSymbol("replacement")],
    });
    await materializeFacts(facts);

    const conn = await getLadybugConn();
    const externalRows = await ladybugDb.queryAll<{
      name: string;
      symbolId: string;
    }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = true AND s.source = 'scip'
       RETURN s.name AS name, s.symbolId AS symbolId
       ORDER BY name`,
      { repoId: REPO_ID },
    );
    assert.equal(externalRows.length, 2);
    const staleSymbolId = externalRows.find((row) => row.name === "api")?.symbolId;
    const survivingSymbolId = externalRows.find(
      (row) => row.name === "replacement",
    )?.symbolId;
    assert.ok(staleSymbolId);
    assert.ok(survivingSymbolId);
    const staleVector = [1, ...new Array<number>(767).fill(0)];
    const survivingVector = [0, 1, ...new Array<number>(766).fill(0)];

    await withWriteConn(async (writeConn) => {
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        REPO_ID,
        staleSymbolId,
        "jina-embeddings-v2-base-code",
        "stale-scip-vector",
        "stale-scip-vector-hash",
        staleVector,
      );
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        REPO_ID,
        survivingSymbolId,
        "jina-embeddings-v2-base-code",
        "surviving-scip-vector",
        "surviving-scip-vector-hash",
        survivingVector,
      );
      assert.equal(
        await createVectorIndex(
          writeConn,
          "SymbolVectorEmbedding",
          "embeddingJinaCodeVec",
          "symbol_vec_jina_code_v2",
          768,
        ),
        true,
      );
      assert.equal(
        await ladybugDb.pruneStaleScipExternalSymbols(
          writeConn,
          REPO_ID,
          [survivingSymbolId],
        ),
        1,
      );
    });

    const staleRows = await ladybugDb.queryAll<{ symbolId: string }>(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       RETURN s.symbolId AS symbolId`,
      { symbolId: staleSymbolId },
    );
    assert.deepEqual(staleRows, []);
    const embeddingRows = await ladybugDb.queryAll<{ symbolId: string }>(
      conn,
      `MATCH (e:SymbolVectorEmbedding {symbolId: $symbolId})
       RETURN e.symbolId AS symbolId`,
      { symbolId: staleSymbolId },
    );
    assert.deepEqual(embeddingRows, []);
    const neighbors = await queryStoredProcAll<{
      symbolId: string;
      distance: number;
    }>(
      conn,
      `CALL QUERY_VECTOR_INDEX('SymbolVectorEmbedding', 'symbol_vec_jina_code_v2', ${JSON.stringify(survivingVector)}, 1, efs := 200) RETURN node.symbolId AS symbolId, distance`,
    );
    assert.equal(neighbors.length, 1);
    assert.equal(neighbors[0]?.symbolId, survivingSymbolId);
    assert.ok(Math.abs(neighbors[0]?.distance ?? Number.POSITIVE_INFINITY) <= 1e-6);
  });

  it("preserves shared SCIP external Symbols and vectors during repo-local pruning", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);
    const otherRepoId = "provider-first-scip-shared-owner";

    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-shared-vector-prune",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [documentForExternal("sharedApi")],
      externalSymbols: [externalSymbol("sharedApi")],
    });
    await materializeFacts(facts);

    const conn = await getLadybugConn();
    const shared = await ladybugDb.querySingle<{ symbolId: string }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = true AND s.source = 'scip'
       RETURN s.symbolId AS symbolId`,
      { repoId: REPO_ID },
    );
    assert.ok(shared);
    await withWriteConn(async (writeConn) => {
      await ladybugDb.upsertRepo(writeConn, {
        repoId: otherRepoId,
        rootPath: join(graphDbPath, "other"),
        configJson: "{}",
        createdAt: NOW,
      });
      await ladybugDb.exec(
        writeConn,
        `MATCH (s:Symbol {symbolId: $symbolId}), (r:Repo {repoId: $otherRepoId})
         CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
        { symbolId: shared.symbolId, otherRepoId },
      );
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        REPO_ID,
        shared.symbolId,
        "jina-embeddings-v2-base-code",
        "shared-scip-vector",
        "shared-scip-vector-hash",
        [1, ...new Array<number>(767).fill(0)],
      );

      assert.equal(
        await ladybugDb.pruneStaleScipExternalSymbols(
          writeConn,
          REPO_ID,
          [],
        ),
        1,
      );
    });

    assert.deepEqual(
      await ladybugDb.querySingle<{
        repoId: string;
        otherMemberships: unknown;
      }>(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         RETURN s.repoId AS repoId,
                count { MATCH (s)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $otherRepoId}) } AS otherMemberships`,
        { symbolId: shared.symbolId, otherRepoId },
      ),
      { repoId: otherRepoId, otherMemberships: 1 },
    );
    assert.deepEqual(
      await ladybugDb.querySingle<{ repoId: string; cardHash: string }>(
        conn,
        `MATCH (e:SymbolVectorEmbedding {symbolId: $symbolId})
         RETURN e.repoId AS repoId, e.cardHash AS cardHash`,
        { symbolId: shared.symbolId },
      ),
      { repoId: otherRepoId, cardHash: "shared-scip-vector-hash" },
    );
  });

  it("materializes multiple SCIP external symbols through the real DB batch path", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);

    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-multi",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [documentForExternals(["apiOne", "apiTwo", "apiThree"])],
      externalSymbols: [
        externalSymbol("apiOne"),
        externalSymbol("apiTwo"),
        externalSymbol("apiThree"),
      ],
    });
    await materializeFacts(facts);

    const conn = await getLadybugConn();
    const externalRows = await ladybugDb.queryAll<{
      name: string;
      packageName: string;
      source: string;
    }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = true AND s.source = 'scip'
       RETURN s.name AS name,
              s.packageName AS packageName,
              s.source AS source
       ORDER BY name`,
      { repoId: REPO_ID },
    );
    assert.deepEqual(externalRows, [
      { name: "apiOne", packageName: "dep", source: "scip" },
      { name: "apiThree", packageName: "dep", source: "scip" },
      { name: "apiTwo", packageName: "dep", source: "scip" },
    ]);
  });

  it("rejects duplicate SCIP external symbols before the DB batch", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);

    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-duplicate",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [documentForExternals(["apiOne"])],
      externalSymbols: [externalSymbol("apiOne"), externalSymbol("apiOne")],
    });
    await assert.rejects(
      () => materializeFacts(facts),
      /duplicate Symbol primary key/i,
    );
  });

  it("invalidates integrity when provider rows are written without independent expectations", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);
    await withWriteConn((conn) =>
      ladybugDb.beginGraphIntegrityVersion(
        conn,
        REPO_ID,
        "verified-version",
        "a".repeat(64),
        true,
      ),
    );

    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-direct-write",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [documentForExternal("api")],
      externalSymbols: [externalSymbol("api")],
    });
    await materializeFacts(facts);

    const state = await getDerivedState(REPO_ID);
    assert.equal(state?.graphIntegrityState, "unknown");
    assert.equal(state?.graphIntegrityRevision, null);
    assert.equal(state?.graphIntegrityVerifiedRevision, null);
  });
});

async function initRepo(graphDbPath: string): Promise<void> {
  await initLadybugDb(graphDbPath);
  await withWriteConn(async (conn) => {
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: graphDbPath,
      configJson: JSON.stringify({ repoId: REPO_ID, rootPath: graphDbPath }),
      createdAt: NOW,
    });
  });
}

async function materializeFacts(
  facts: ReturnType<typeof normalizeScipProviderFacts>,
  testCaseCandidatesByPath?: ReadonlyMap<
    string,
    ReturnType<typeof detectTypeScriptTestCases>
  >,
): Promise<void> {
  for (const file of facts.files) {
    file.contentHash ??= "0".repeat(64);
    file.byteSize ??= 128;
  }
  const rows = providerFactsToGraphRows({
    facts,
    indexedAt: NOW,
    testCaseCandidatesByPath,
  });
  await withWriteConn(async (conn) => {
    await materializeProviderFacts(conn, rows);
  });
}

function documentForExternal(name: string) {
  return documentForExternals([name]);
}

function documentForExternals(names: string[]) {
  const local = "scip-typescript npm fixture 1.0.0 src/index.ts/main().";
  const externalOccurrences = names.map((name, index) => ({
    range: {
      startLine: index + 1,
      startCol: 9,
      endLine: index + 1,
      endCol: 9 + name.length,
    },
    symbol: externalSymbol(name).symbol,
    symbolRoles: 2,
    overrideDocumentation: [],
    syntaxKind: 0,
    diagnostics: [],
  }));
  return {
    language: "typescript",
    relativePath: "src/index.ts",
    occurrences: [
      {
        range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
        enclosingRange: {
          startLine: 0,
          startCol: 0,
          endLine: 3,
          endCol: 1,
        },
        symbol: local,
        symbolRoles: 1,
        overrideDocumentation: [],
        syntaxKind: 0,
        diagnostics: [],
      },
      ...externalOccurrences,
    ],
    symbols: [
      {
        symbol: local,
        documentation: [],
        kind: 12,
        displayName: "main",
        relationships: names.map((name) => ({
          symbol: externalSymbol(name).symbol,
          isDefinition: true,
        })),
      },
    ],
  };
}

function externalSymbol(name: string) {
  return {
    symbol: `scip-typescript npm dep 1.0.0 dep/index.ts/${name}().`,
    documentation: [`External ${name}.`],
    kind: 12,
    displayName: name,
  };
}
