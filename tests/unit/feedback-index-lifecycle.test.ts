/**
 * feedback-index-lifecycle.test.ts
 *
 * Tests for AgentFeedback entries in the index lifecycle constants
 * (ENTITY_FTS_INDEX_NAMES, AGENTFEEDBACK_VECTOR_INDEX_NAMES,
 * AGENTFEEDBACK_EMBEDDING_PROPERTIES).
 *
 * index-lifecycle.ts depends on kuzu (LadybugDB) connections and
 * src/db/ladybug.ts which transitively imports src/util/tracing.ts — an
 * OTel module that breaks in the tsx unit-test environment.  Tests therefore
 * use source-reading and structural validation instead of live imports.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lifecycleSrc = readFileSync(
  join(process.cwd(), "src/retrieval/index-lifecycle.ts"),
  "utf8",
);

describe("agentFeedback index lifecycle constants", () => {
  it("ENTITY_FTS_INDEX_NAMES includes agentFeedback", () => {
    assert.ok(
      lifecycleSrc.includes('agentFeedback: "agentfeedback_search_text_v1"'),
      "ENTITY_FTS_INDEX_NAMES should contain agentFeedback entry",
    );
  });

  it("AGENTFEEDBACK_VECTOR_INDEX_NAMES has jinaCode and nomic entries", () => {
    assert.ok(
      lifecycleSrc.includes("AGENTFEEDBACK_VECTOR_INDEX_NAMES"),
      "Source should export AGENTFEEDBACK_VECTOR_INDEX_NAMES",
    );
    assert.ok(
      lifecycleSrc.includes('"agentfeedback_vec_jina_code_v2"'),
      "AGENTFEEDBACK_VECTOR_INDEX_NAMES should have jinaCode index name",
    );
    assert.ok(
      lifecycleSrc.includes('"agentfeedback_vec_nomic_embed_v15"'),
      "AGENTFEEDBACK_VECTOR_INDEX_NAMES should have nomic index name",
    );
  });

  it("AGENTFEEDBACK_EMBEDDING_PROPERTIES has correct dimensions", () => {
    assert.ok(
      lifecycleSrc.includes("AGENTFEEDBACK_EMBEDDING_PROPERTIES"),
      "Source should export AGENTFEEDBACK_EMBEDDING_PROPERTIES",
    );
    // Verify jinaCode dimension (768) and nomic dimension (768) are present
    // in the AGENTFEEDBACK_EMBEDDING_PROPERTIES block
    const propsIdx = lifecycleSrc.indexOf("AGENTFEEDBACK_EMBEDDING_PROPERTIES");
    const propsBlock = lifecycleSrc.substring(propsIdx, lifecycleSrc.indexOf("} as const;", propsIdx) + 12);
    assert.ok(
      propsBlock.includes("dimension: 768"),
      "jinaCode dimension should be 768",
    );
    assert.ok(
      propsBlock.includes("dimension: 768"),
      "nomic dimension should be 768",
    );
    assert.ok(
      propsBlock.includes('property: "embeddingJinaCode"'),
      "jinaCode property should be embeddingJinaCode",
    );
    assert.ok(
      propsBlock.includes('property: "embeddingNomic"'),
      "nomic property should be embeddingNomic",
    );
  });
});

describe("ensureEntityIndexes includes AgentFeedback", () => {
  it("ftsTables array includes AgentFeedback entry", () => {
    assert.ok(
      lifecycleSrc.includes('{ table: "AgentFeedback", indexName: ENTITY_FTS_INDEX_NAMES.agentFeedback }'),
      "ftsTables should include AgentFeedback entry",
    );
  });

  it("ensureEntityIndexes creates AgentFeedback vector indexes", () => {
    // Verify the function body references AgentFeedback vector constants
    const fnIdx = lifecycleSrc.indexOf("ensureEntityIndexes");
    const fnBody = lifecycleSrc.substring(fnIdx);

    assert.ok(
      fnBody.includes("AGENTFEEDBACK_VECTOR_INDEX_NAMES"),
      "ensureEntityIndexes should reference AGENTFEEDBACK_VECTOR_INDEX_NAMES",
    );
    assert.ok(
      fnBody.includes("AGENTFEEDBACK_EMBEDDING_PROPERTIES"),
      "ensureEntityIndexes should reference AGENTFEEDBACK_EMBEDDING_PROPERTIES",
    );
    assert.ok(
      fnBody.includes('createVectorIndex(conn, "AgentFeedback"'),
      "ensureEntityIndexes should call createVectorIndex for AgentFeedback",
    );
  });
});
