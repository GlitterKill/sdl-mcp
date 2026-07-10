import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyLegacyEmbeddingRow,
  decodeStoredEmbeddingVector,
  findDuplicateSymbolIds,
  storedEmbeddingVectorsEqual,
} from "../../dist/db/migrations/symbol-embedding-remediation.js";

interface LegacyEmbeddingFixture {
  symbolId: string | null;
  model: string | null;
  embeddingVector: string | null;
  version: string | null;
  cardHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface DestinationEmbeddingFixture {
  symbolId: string;
  vector: string | null;
  cardHash: string | null;
  updatedAt: string | null;
}

const vector = (dimension: number, value = 0): number[] =>
  Array.from({ length: dimension }, () => value);

const encoded = (dimension: number, value = 0): string =>
  JSON.stringify(vector(dimension, value));

const legacyRow = (
  overrides: Partial<LegacyEmbeddingFixture> = {},
): LegacyEmbeddingFixture => ({
  symbolId: "symbol-1",
  model: "all-MiniLM-L6-v2",
  embeddingVector: encoded(384),
  version: "v1",
  cardHash: null,
  createdAt: "2026-07-09T12:00:00.000Z",
  updatedAt: null,
  ...overrides,
});

const destinationRow = (
  overrides: Partial<DestinationEmbeddingFixture> = {},
): DestinationEmbeddingFixture => ({
  symbolId: "symbol-1",
  vector: null,
  cardHash: null,
  updatedAt: null,
  ...overrides,
});

describe("SymbolEmbedding remediation vector decoding", () => {
  it("accepts only the exact dimension for each recognized model", () => {
    assert.equal(
      decodeStoredEmbeddingVector(encoded(384), "all-MiniLM-L6-v2")?.length,
      384,
    );
    assert.equal(
      decodeStoredEmbeddingVector(encoded(768), "nomic-embed-text-v1.5")
        ?.length,
      768,
    );

    for (const dimension of [383, 385]) {
      assert.equal(
        decodeStoredEmbeddingVector(
          encoded(dimension),
          "all-MiniLM-L6-v2",
        ),
        null,
      );
    }
    for (const dimension of [767, 769]) {
      assert.equal(
        decodeStoredEmbeddingVector(
          encoded(dimension),
          "nomic-embed-text-v1.5",
        ),
        null,
      );
    }
  });

  it("rejects malformed JSON and non-numeric vectors", () => {
    for (const raw of [
      "{}",
      "not-json",
      '"text"',
      "true",
      "null",
      JSON.stringify(["0", ...vector(383)]),
    ]) {
      assert.equal(
        decodeStoredEmbeddingVector(raw, "all-MiniLM-L6-v2"),
        null,
      );
    }
    assert.equal(
      decodeStoredEmbeddingVector(null, "all-MiniLM-L6-v2"),
      null,
    );
  });

  it("rejects non-finite numbers parsed from raw JSON", () => {
    const rawNonFinite = "[1e309," + encoded(383).slice(1);

    assert.equal(
      decodeStoredEmbeddingVector(rawNonFinite, "all-MiniLM-L6-v2"),
      null,
    );
  });
});

describe("SymbolEmbedding remediation vector equality", () => {
  it("compares decoded values instead of serialized spelling", () => {
    const exponentEncoded =
      "[" + Array.from({ length: 384 }, () => "1e0").join(", ") + "]";

    assert.equal(
      storedEmbeddingVectorsEqual(
        encoded(384, 1),
        exponentEncoded,
        "all-MiniLM-L6-v2",
      ),
      true,
    );
    assert.equal(
      storedEmbeddingVectorsEqual(
        encoded(383, 1),
        encoded(383, 1),
        "all-MiniLM-L6-v2",
      ),
      false,
    );
  });

  it("distinguishes negative zero from zero", () => {
    const negativeZeroEncoded = "[-0," + encoded(383).slice(1);

    assert.equal(
      storedEmbeddingVectorsEqual(
        negativeZeroEncoded,
        encoded(384),
        "all-MiniLM-L6-v2",
      ),
      false,
    );
    assert.equal(
      storedEmbeddingVectorsEqual(
        negativeZeroEncoded,
        negativeZeroEncoded,
        "all-MiniLM-L6-v2",
      ),
      true,
    );
  });
});

describe("SymbolEmbedding remediation classification", () => {
  it("copies a valid recognized source into a completely empty lane", () => {
    const source = legacyRow();
    const destination = destinationRow();

    assert.deepEqual(
      classifyLegacyEmbeddingRow(source, destination, new Set()),
      {
        kind: "copy",
        source,
        destination,
      },
    );
  });

  it("recognizes a semantically equal destination with null-safe metadata", () => {
    const exponentEncoded =
      "[" + Array.from({ length: 384 }, () => "1e0").join(", ") + "]";
    const source = legacyRow({ embeddingVector: encoded(384, 1) });
    const destination = destinationRow({ vector: exponentEncoded });

    assert.deepEqual(
      classifyLegacyEmbeddingRow(source, destination, new Set()),
      {
        kind: "alreadyCurrent",
        source,
        destination,
      },
    );
  });

  it("retains vector, hash, and timestamp conflicts", () => {
    const cases: Array<{
      source: LegacyEmbeddingFixture;
      destination: DestinationEmbeddingFixture;
    }> = [
      {
        source: legacyRow(),
        destination: destinationRow({ vector: encoded(384, 2) }),
      },
      {
        source: legacyRow({ cardHash: "source-hash" }),
        destination: destinationRow({
          vector: encoded(384),
          cardHash: "destination-hash",
        }),
      },
      {
        source: legacyRow({ updatedAt: "source-time" }),
        destination: destinationRow({
          vector: encoded(384),
          updatedAt: "destination-time",
        }),
      },
    ];

    for (const { source, destination } of cases) {
      assert.deepEqual(
        classifyLegacyEmbeddingRow(source, destination, new Set()),
        { kind: "retain", reason: "conflict" },
      );
    }
  });

  it("does not treat a null vector with non-null metadata as empty", () => {
    assert.deepEqual(
      classifyLegacyEmbeddingRow(
        legacyRow(),
        destinationRow({ cardHash: "existing-hash" }),
        new Set(),
      ),
      { kind: "retain", reason: "conflict" },
    );
  });

  it("retains mismatched destination symbols as orphaned", () => {
    const source = legacyRow({ embeddingVector: encoded(384, 1) });
    const destinations = [
      destinationRow({ symbolId: "other-symbol" }),
      destinationRow({
        symbolId: "other-symbol",
        vector: encoded(384, 1),
      }),
    ];

    for (const destination of destinations) {
      assert.deepEqual(
        classifyLegacyEmbeddingRow(source, destination, new Set()),
        { kind: "retain", reason: "orphan" },
      );
    }
  });

  it("retains rows whose destination symbol is absent", () => {
    assert.deepEqual(
      classifyLegacyEmbeddingRow(legacyRow(), null, new Set()),
      { kind: "retain", reason: "orphan" },
    );
  });

  it("retains missing ids and invalid vectors as malformed", () => {
    for (const source of [
      legacyRow({ symbolId: "" }),
      legacyRow({ symbolId: null }),
      legacyRow({ embeddingVector: "not-json" }),
    ]) {
      assert.deepEqual(
        classifyLegacyEmbeddingRow(source, destinationRow(), new Set()),
        { kind: "retain", reason: "malformed" },
      );
    }
  });

  it("retains mock, unknown, and null models in separate safety lanes", () => {
    assert.deepEqual(
      classifyLegacyEmbeddingRow(
        legacyRow({ model: "mock-fallback" }),
        destinationRow(),
        new Set(),
      ),
      { kind: "retain", reason: "mock" },
    );
    for (const model of ["future-model", null]) {
      assert.deepEqual(
        classifyLegacyEmbeddingRow(
          legacyRow({ model }),
          destinationRow(),
          new Set(),
        ),
        { kind: "retain", reason: "unknownModel" },
      );
    }
  });

  it("finds every repeated non-empty symbol id", () => {
    const duplicates = findDuplicateSymbolIds([
      { symbolId: "symbol-a" },
      { symbolId: "" },
      { symbolId: null },
      { symbolId: "symbol-a" },
      { symbolId: "symbol-b" },
      { symbolId: "symbol-b" },
      { symbolId: "symbol-b" },
    ]);

    assert.deepEqual([...duplicates], ["symbol-a", "symbol-b"]);
  });

  it("retains every row whose id is duplicated in the query result", () => {
    const sources = [
      legacyRow({ symbolId: "duplicate-symbol" }),
      legacyRow({
        symbolId: "duplicate-symbol",
        model: "nomic-embed-text-v1.5",
        embeddingVector: encoded(768),
      }),
    ];
    const duplicateIds = findDuplicateSymbolIds(sources);

    for (const source of sources) {
      assert.deepEqual(
        classifyLegacyEmbeddingRow(
          source,
          destinationRow({ symbolId: "duplicate-symbol" }),
          duplicateIds,
        ),
        { kind: "retain", reason: "duplicateQueryResult" },
      );
    }
  });
});
