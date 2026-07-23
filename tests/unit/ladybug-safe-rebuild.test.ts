import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  readSafeRebuildSymbolPointLookupSample,
  SAFE_REBUILD_SYMBOL_STRING_FIELDS,
} from "../../dist/db/ladybug-safe-rebuild.js";
import { NODE_TABLES } from "../../dist/db/ladybug-schema.js";

class FakeQueryResult {
  private readonly rows: Record<string, unknown>[];

  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    return this.rows;
  }

  close(): void {}
}

function symbolProjection(
  overrides: Partial<Record<string, string | null>> = {},
): Record<string, string | null> {
  return {
    symbolId: "sym-1",
    repoId: "repo",
    kind: "function",
    name: "scan-name",
    visibility: "",
    language: "typescript",
    astFingerprint: "scan-fingerprint",
    signatureJson: "",
    summary: "",
    summarySource: "unknown",
    invariantsJson: "",
    sideEffectsJson: "",
    roleTagsJson: "",
    searchText: "scan-name",
    updatedAt: "2026-07-23T00:00:00.000Z",
    embeddingMiniLM: null,
    embeddingMiniLMCardHash: null,
    embeddingMiniLMUpdatedAt: null,
    embeddingNomic: null,
    embeddingNomicCardHash: null,
    embeddingNomicUpdatedAt: null,
    embeddingJinaCode: null,
    embeddingJinaCodeCardHash: null,
    embeddingJinaCodeUpdatedAt: null,
    scipSymbol: "",
    source: "treesitter",
    packageName: "",
    packageVersion: "",
    symbolStatus: "real",
    placeholderKind: "",
    placeholderTarget: "",
    ...overrides,
  };
}

describe("safe rebuild Symbol point-lookup parity", () => {
  it("covers every STRING column in the current Symbol schema", () => {
    const symbolTable = NODE_TABLES.find((statement) =>
      statement.includes("CREATE NODE TABLE IF NOT EXISTS Symbol ("),
    );
    assert.ok(symbolTable, "Symbol table DDL must exist");
    const schemaStringFields = symbolTable
      .split(/\r?\n/u)
      .map(
        (line) =>
          line
            .trim()
            .match(/^([A-Za-z][A-Za-z0-9_]*)\s+STRING(?:\s|,|$)/u)?.[1],
      )
      .filter((field): field is string => field !== undefined);

    assert.deepStrictEqual(
      [...SAFE_REBUILD_SYMBOL_STRING_FIELDS],
      schemaStringFields,
    );
  });

  it("rejects coherent IDs whose scan-visible strings disagree with scalar PK lookup", async () => {
    const statements: string[] = [];
    const paramsLog: Record<string, unknown>[] = [];
    const scan = symbolProjection();
    const point = symbolProjection({
      name: "point-name",
      scipSymbol: "scip . . sym-1().",
    });
    const conn = {
      async prepare(statement: string) {
        return { statement };
      },
      async execute(
        prepared: { statement: string },
        params: Record<string, unknown>,
      ) {
        statements.push(prepared.statement);
        paramsLog.push(params);
        if (
          prepared.statement.includes(
            "MATCH (s:Symbol {symbolId: $symbolId0})",
          )
        ) {
          return new FakeQueryResult([
            {
              ordinal: 0,
              requestedSymbolId: params.symbolId0,
              ...point,
            },
          ]);
        }
        if ("afterSymbolId" in params) {
          return new FakeQueryResult([]);
        }
        return new FakeQueryResult([scan]);
      },
    } as unknown as import("kuzu").Connection;

    const result = await readSafeRebuildSymbolPointLookupSample(conn);

    assert.deepStrictEqual(result.symbolIds, ["sym-1"]);
    assert.equal(result.scannedTotal, 1);
    assert.equal(result.mismatchTotal, 1);
    assert.deepStrictEqual(result.mismatches, [
      {
        symbolId: "sym-1",
        fields: ["name", "scipSymbol"],
      },
    ]);
    assert.ok(
      statements.some((statement) =>
        statement.includes("MATCH (s:Symbol {symbolId: $symbolId0})"),
      ),
      "parity must use scalar primary-key probes",
    );
    assert.ok(
      statements.every((statement) => !statement.includes("UNWIND")),
      "UNWIND-derived property lookup is not a reliable PK oracle",
    );
    assert.ok(
      paramsLog.some((params) => params.symbolId0 === "sym-1"),
      "the scan-visible ID must be passed as a scalar parameter",
    );
  });

  it("rejects a scalar PK branch that returns more than one physical row", async () => {
    const scan = symbolProjection();
    const conn = {
      async prepare(statement: string) {
        return { statement };
      },
      async execute(
        prepared: { statement: string },
        params: Record<string, unknown>,
      ) {
        if (
          prepared.statement.includes(
            "MATCH (s:Symbol {symbolId: $symbolId0})",
          )
        ) {
          const point = {
            ordinal: 0,
            requestedSymbolId: params.symbolId0,
            ...scan,
          };
          return new FakeQueryResult([point, point]);
        }
        return new FakeQueryResult([scan]);
      },
    } as unknown as import("kuzu").Connection;

    const result = await readSafeRebuildSymbolPointLookupSample(conn);

    assert.equal(result.mismatchTotal, 1);
    assert.deepStrictEqual(result.mismatches, [
      {
        symbolId: "sym-1",
        fields: ["pointLookupCopies"],
      },
    ]);
  });

  it("checks every row beyond the 2,048-row scan boundary", async () => {
    const scannedRows = Array.from({ length: 2_049 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return symbolProjection({
        symbolId: `sym-${suffix}`,
        name: `name-${suffix}`,
        astFingerprint: `fingerprint-${suffix}`,
        searchText: `name-${suffix}`,
        scipSymbol: `scip . . sym-${suffix}().`,
      });
    });
    const pointRows = new Map(
      scannedRows.map((row) => [row.symbolId, { ...row }]),
    );
    pointRows.set("sym-2048", {
      ...pointRows.get("sym-2048")!,
      embeddingJinaCodeCardHash: "point-only-card-hash",
    });
    const scanParams: Record<string, unknown>[] = [];
    const pointStatements: string[] = [];
    const conn = {
      async prepare(statement: string) {
        return { statement };
      },
      async execute(
        prepared: { statement: string },
        params: Record<string, unknown>,
      ) {
        if (
          prepared.statement.includes(
            "MATCH (s:Symbol {symbolId: $symbolId0})",
          )
        ) {
          pointStatements.push(prepared.statement);
          const rows = Object.entries(params)
            .filter(([name]) => /^symbolId\d+$/u.test(name))
            .map(([name, symbolId]) => {
              const ordinal = Number(name.slice("symbolId".length));
              const point = pointRows.get(String(symbolId));
              return point
                ? {
                    ordinal,
                    requestedSymbolId: symbolId,
                    ...point,
                  }
                : undefined;
            })
            .filter(
              (row): row is NonNullable<typeof row> => row !== undefined,
            );
          return new FakeQueryResult(rows);
        }
        scanParams.push(params);
        return new FakeQueryResult(
          "afterSymbolId" in params
            ? scannedRows.slice(2_048)
            : scannedRows.slice(0, 2_048),
        );
      },
    } as unknown as import("kuzu").Connection;

    const result = await readSafeRebuildSymbolPointLookupSample(conn);

    assert.equal(result.scannedTotal, 2_049);
    assert.equal(result.mismatchTotal, 1);
    assert.deepStrictEqual(result.mismatches, [
      {
        symbolId: "sym-2048",
        fields: ["embeddingJinaCodeCardHash"],
      },
    ]);
    assert.equal(scanParams.length, 2);
    assert.equal(scanParams[1]?.afterSymbolId, "sym-2047");
    assert.equal(pointStatements.length, 33);
    assert.equal(
      pointStatements[0]?.match(/MATCH \(s:Symbol/gu)?.length,
      64,
    );
    assert.equal(
      pointStatements[0]?.match(/UNION ALL/gu)?.length,
      63,
    );
    assert.ok(
      pointStatements.every((statement) => !statement.includes("UNWIND")),
      "every parity branch must retain a scalar PK parameter",
    );
  });
});
