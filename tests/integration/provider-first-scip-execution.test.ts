import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  materializeProviderFacts,
  providerFactsToGraphRows,
} from "../../dist/indexer/provider-first/materializer.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";

const REPO_ID = "provider-first-scip-execution";
const NOW = "2026-05-25T12:00:00.000Z";

describe("provider-first SCIP materialization", () => {
  let graphDbPath = "";

  afterEach(async () => {
    await closeLadybugDb();
    if (graphDbPath && existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    graphDbPath = "";
  });

  it("materializes SCIP files, symbols, external symbols, ranges, and syntax-proved edges", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-db-"));
    await initRepo(graphDbPath);

    const main =
      "scip-typescript npm fixture 1.0.0 src/index.ts/main().";
    const helper =
      "scip-typescript npm fixture 1.0.0 src/index.ts/helper().";
    const external =
      "scip-typescript npm dep 1.0.0 dep/index.ts/api().";
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

  it("deduplicates duplicate SCIP external symbols in one real DB batch", async () => {
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
    await materializeFacts(facts);

    const conn = await getLadybugConn();
    const relRow = await ladybugDb.querySingle<{ relCount: unknown }>(
      conn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = true AND s.source = 'scip' AND s.name = 'apiOne'
       RETURN count(r) AS relCount`,
      { repoId: REPO_ID },
    );
    assert.equal(ladybugDb.toNumber(relRow?.relCount), 1);
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
): Promise<void> {
  const rows = providerFactsToGraphRows({ facts, indexedAt: NOW });
  await withWriteConn(async (conn) => {
    await materializeProviderFacts(conn, rows);
  });
}

function documentForExternal(name: string) {
  return documentForExternals([name]);
}

function documentForExternals(names: string[]) {
  const local =
    "scip-typescript npm fixture 1.0.0 src/index.ts/main().";
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
