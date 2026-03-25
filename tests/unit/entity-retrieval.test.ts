/**
 * Tests for entity retrieval types (Stage 3).
 *
 * These tests verify the type surface of the multi-entity hybrid search
 * system.  Since all types in src/retrieval/types.ts are TypeScript
 * interfaces / type aliases that compile away, the assertions here focus on:
 *   - the type structures being assignable (compile-time checks via typed variables)
 *   - runtime-visible constants and behaviour derived from those types
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// All imports are type-only — they disappear at runtime (types.js is empty).
import type {
  EntityType,
  EntitySearchOptions,
  EntitySearchResultItem,
  EntitySearchResult,
  RetrievalSource,
} from "../../dist/retrieval/types.js";

describe("EntityType – type surface", () => {
  it("should cover all five expected entity kinds", () => {
    // Build an array of every valid EntityType value and verify the count.
    // This acts as a compile-time guard: if a new kind is added or removed
    // the TypeScript compiler will catch the mismatch before runtime.
    const allTypes: EntityType[] = [
      "symbol",
      "memory",
      "cluster",
      "process",
      "fileSummary",
      "agentFeedback",
    ];
    assert.equal(allTypes.length, 6, "EntityType union should have 6 members");
  });

  it("should distinguish symbol from other entity types", () => {
    const t: EntityType = "symbol";
    assert.notEqual(t, "memory");
    assert.notEqual(t, "cluster");
    assert.notEqual(t, "process");
    assert.notEqual(t, "fileSummary");
  });
});

describe("EntitySearchOptions – type surface", () => {
  it("should accept minimal required fields", () => {
    const opts: EntitySearchOptions = {
      repoId: "test-repo",
      query: "authentication",
      limit: 10,
    };
    assert.equal(opts.repoId, "test-repo");
    assert.equal(opts.query, "authentication");
    assert.equal(opts.limit, 10);
    assert.equal(opts.entityTypes, undefined, "entityTypes defaults to undefined (all)");
  });

  it("should accept optional entityTypes filter", () => {
    const opts: EntitySearchOptions = {
      repoId: "test-repo",
      query: "auth",
      limit: 5,
      entityTypes: ["memory", "cluster"],
    };
    assert.deepEqual(opts.entityTypes, ["memory", "cluster"]);
  });

  it("should accept single entity type filter", () => {
    const opts: EntitySearchOptions = {
      repoId: "test-repo",
      query: "login",
      limit: 20,
      entityTypes: ["fileSummary"],
    };
    assert.deepEqual(opts.entityTypes, ["fileSummary"]);
  });

  it("should accept all entity types as filter", () => {
    const all: EntityType[] = ["symbol", "memory", "cluster", "process", "fileSummary"];
    const opts: EntitySearchOptions = {
      repoId: "test-repo",
      query: "all",
      limit: 100,
      entityTypes: all,
    };
    assert.equal(opts.entityTypes?.length, 5);
  });

  it("should accept optional FTS and vector flags", () => {
    const opts: EntitySearchOptions = {
      repoId: "r",
      query: "q",
      limit: 1,
      ftsEnabled: true,
      vectorEnabled: false,
      fusionStrategy: "rrf",
      rrfK: 60,
      candidateLimit: 200,
      includeEvidence: true,
    };
    assert.equal(opts.ftsEnabled, true);
    assert.equal(opts.vectorEnabled, false);
    assert.equal(opts.fusionStrategy, "rrf");
    assert.equal(opts.rrfK, 60);
    assert.equal(opts.candidateLimit, 200);
    assert.equal(opts.includeEvidence, true);
  });
});

describe("EntitySearchResultItem – type surface", () => {
  it("should hold entityType, entityId, score, and source", () => {
    const item: EntitySearchResultItem = {
      entityType: "memory",
      entityId: "mem-abc123",
      score: 0.95,
      source: "fts",
    };
    assert.equal(item.entityType, "memory");
    assert.equal(item.entityId, "mem-abc123");
    assert.equal(item.score, 0.95);
    assert.equal(item.source, "fts");
  });

  it("should accept all valid RetrievalSource values", () => {
    const sources: RetrievalSource[] = [
      "fts",
      "vector:minilm",
      "vector:nomic",
      "legacyFallback",
      "overlay",
    ];
    for (const source of sources) {
      const item: EntitySearchResultItem = {
        entityType: "cluster",
        entityId: "cluster-1",
        score: 0.5,
        source,
      };
      assert.equal(item.source, source);
    }
  });

  it("should accept cluster entity type", () => {
    const item: EntitySearchResultItem = {
      entityType: "cluster",
      entityId: "cluster-xyz",
      score: 0.75,
      source: "vector:minilm",
    };
    assert.equal(item.entityType, "cluster");
  });

  it("should accept fileSummary entity type", () => {
    const item: EntitySearchResultItem = {
      entityType: "fileSummary",
      entityId: "src/auth/login.ts",
      score: 0.82,
      source: "fts",
    };
    assert.equal(item.entityType, "fileSummary");
    assert.equal(item.entityId, "src/auth/login.ts");
  });
});

describe("EntitySearchResult – type surface", () => {
  it("should hold an array of EntitySearchResultItem", () => {
    const result: EntitySearchResult = {
      results: [
        { entityType: "symbol", entityId: "sym-1", score: 0.9, source: "fts" },
        { entityType: "memory", entityId: "mem-1", score: 0.8, source: "vector:nomic" },
      ],
    };
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].entityType, "symbol");
    assert.equal(result.results[1].entityType, "memory");
  });

  it("should accept optional evidence field", () => {
    const result: EntitySearchResult = {
      results: [],
      evidence: {
        sources: ["fts"],
        topRanksPerSource: { fts: [1, 2, 3] },
        candidateCountPerSource: { fts: 10 },
        fusionLatencyMs: 5,
      },
    };
    assert.deepEqual(result.evidence?.sources, ["fts"]);
    assert.equal(result.evidence?.fusionLatencyMs, 5);
  });

  it("should allow empty results array", () => {
    const result: EntitySearchResult = { results: [] };
    assert.equal(result.results.length, 0);
    assert.equal(result.evidence, undefined);
  });
});
