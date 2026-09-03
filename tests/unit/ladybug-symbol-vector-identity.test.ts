import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { SemanticConfigSchema } from "../../dist/config/types.js";
import {
  resolveSymbolVectorPhysicalIdentity,
  type SymbolVectorPhysicalIdentity,
} from "../../dist/db/ladybug-queries.js";
import { IndexError } from "../../dist/domain/errors.js";

const JINA_MODEL = "jina-embeddings-v2-base-code";
const NOMIC_MODEL = "nomic-embed-text-v1.5";

function hashRepoId(repoId: string): string {
  return createHash("sha256").update(repoId).digest("hex").slice(0, 32);
}

describe("resolveSymbolVectorPhysicalIdentity", () => {
  it("derives byte-stable repository-scoped names", () => {
    const repoId = "repo-alpha";
    const repoHash = hashRepoId(repoId);
    const expected: SymbolVectorPhysicalIdentity = {
      repoHash,
      tableName: `SymbolVectorEmbedding_r_${repoHash}`,
      indexName: `symbol_vec_jina_code_v2_r_${repoHash}`,
      propertyName: "embeddingJinaCodeVec",
    };

    const first = resolveSymbolVectorPhysicalIdentity(repoId, JINA_MODEL);
    const second = resolveSymbolVectorPhysicalIdentity(repoId, JINA_MODEL);
    const otherRepo = resolveSymbolVectorPhysicalIdentity(
      "repo-beta",
      JINA_MODEL,
    );

    assert.deepStrictEqual(first, expected);
    assert.deepStrictEqual(second, expected);
    assert.notStrictEqual(otherRepo.repoHash, repoHash);
    assert.notStrictEqual(otherRepo.tableName, first.tableName);
    assert.notStrictEqual(otherRepo.indexName, first.indexName);
    assert.ok(otherRepo.tableName.endsWith(`_r_${otherRepo.repoHash}`));
    assert.ok(otherRepo.indexName.endsWith(`_r_${otherRepo.repoHash}`));
  });

  it("shares one repository table across models while keeping indexes distinct", () => {
    const jina = resolveSymbolVectorPhysicalIdentity("repo-alpha", JINA_MODEL);
    const nomic = resolveSymbolVectorPhysicalIdentity(
      "repo-alpha",
      NOMIC_MODEL,
    );

    assert.strictEqual(jina.repoHash, nomic.repoHash);
    assert.strictEqual(jina.tableName, nomic.tableName);
    assert.notStrictEqual(jina.indexName, nomic.indexName);
    assert.notStrictEqual(jina.propertyName, nomic.propertyName);
  });

  it("rejects empty repository IDs and unsupported models with IndexError", () => {
    assert.throws(
      () => resolveSymbolVectorPhysicalIdentity("", JINA_MODEL),
      (error: unknown) => {
        assert.ok(error instanceof IndexError);
        assert.match(error.message, /repository ID/i);
        return true;
      },
    );
    assert.throws(
      () => resolveSymbolVectorPhysicalIdentity("repo-alpha", "unknown-model"),
      (error: unknown) => {
        assert.ok(error instanceof IndexError);
        assert.match(error.message, /unsupported embedding model/i);
        return true;
      },
    );
  });

  it("rejects one logical index stem shared by two supported models", () => {
    const sharedIndexName = "shared_symbol_vector";
    const semanticConfig = SemanticConfigSchema.parse({
      retrieval: {
        vector: {
          indexes: {
            [JINA_MODEL]: { indexName: sharedIndexName },
            [NOMIC_MODEL]: { indexName: sharedIndexName },
          },
        },
      },
    });

    for (const model of [JINA_MODEL, NOMIC_MODEL]) {
      assert.throws(
        () =>
          resolveSymbolVectorPhysicalIdentity(
            "repo-alpha",
            model,
            semanticConfig,
          ),
        (error: unknown) => {
          assert.ok(error instanceof IndexError);
          assert.match(error.message, /shared_symbol_vector/);
          assert.match(error.message, /configure unique indexName values/i);
          assert.match(error.message, /semantic\.retrieval\.vector\.indexes/);
          return true;
        },
      );
    }
  });

  it("rejects a configured index stem whose physical name exceeds 64 characters", () => {
    const semanticConfig = SemanticConfigSchema.parse({
      retrieval: {
        vector: {
          indexes: {
            [JINA_MODEL]: { indexName: "a".repeat(30) },
          },
        },
      },
    });

    assert.throws(
      () =>
        resolveSymbolVectorPhysicalIdentity(
          "repo-alpha",
          JINA_MODEL,
          semanticConfig,
        ),
      (error: unknown) => {
        assert.ok(error instanceof IndexError);
        assert.match(error.message, /65 characters/);
        assert.match(error.message, /64-character identifier limit/);
        assert.match(
          error.message,
          /semantic\.retrieval\.vector\.indexes.*indexName/,
        );
        return true;
      },
    );
  });
});
