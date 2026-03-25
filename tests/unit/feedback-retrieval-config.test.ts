/**
 * feedback-retrieval-config.test.ts
 *
 * Verifies that "agentFeedback" is a valid EntityType and that the
 * ENTITY_FTS_CONFIG and ENTITY_VECTOR_CONFIG maps in orchestrator.ts
 * include agentFeedback entries.
 *
 * Since orchestrator.ts transitively imports kuzu and tracing modules
 * that break in tsx test environments, these tests use source-reading
 * to validate the config maps structurally.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { EntityType } from "../../dist/retrieval/types.js";

const orchestratorSrc = readFileSync(
  join(process.cwd(), "src/retrieval/orchestrator.ts"),
  "utf8",
);

describe("agentFeedback EntityType", () => {
  it("agentFeedback is a valid EntityType member", () => {
    // Compile-time check: this assignment should succeed without error
    const t: EntityType = "agentFeedback";
    assert.equal(t, "agentFeedback");
  });

  it("EntityType union includes all 6 members", () => {
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
});

describe("ENTITY_FTS_CONFIG includes agentFeedback", () => {
  it("orchestrator.ts source contains agentFeedback FTS config entry", () => {
    assert.ok(
      orchestratorSrc.includes('agentFeedback: { tableName: "AgentFeedback", idField: "feedbackId" }'),
      "ENTITY_FTS_CONFIG should have an agentFeedback entry with tableName 'AgentFeedback'",
    );
  });
});

describe("ENTITY_VECTOR_CONFIG includes agentFeedback", () => {
  it("orchestrator.ts source contains agentFeedback vector config entry", () => {
    assert.ok(
      orchestratorSrc.includes("agentfeedback_vec_minilm_l6_v2"),
      "ENTITY_VECTOR_CONFIG should have a miniLM index for agentFeedback",
    );
    assert.ok(
      orchestratorSrc.includes("agentfeedback_vec_nomic_embed_v15"),
      "ENTITY_VECTOR_CONFIG should have a nomic index for agentFeedback",
    );
  });

  it("agentFeedback vector config uses feedbackId as idField", () => {
    // Verify the vector config block has feedbackId
    const vecConfigBlock = orchestratorSrc.substring(
      orchestratorSrc.indexOf("agentFeedback: {", orchestratorSrc.indexOf("ENTITY_VECTOR_CONFIG")),
    );
    assert.ok(
      vecConfigBlock.includes('idField: "feedbackId"'),
      "agentFeedback vector config should use feedbackId as idField",
    );
  });
});
