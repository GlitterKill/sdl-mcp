import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

describe("fresh schema vector layout", () => {
  it("omits the shared Symbol vector table while preserving fixed bootstrap indexes", async (t) => {
    const core = await import("../../dist/db/ladybug-core.js");
    const caps = await import("../../dist/db/extension-caps.js");
    const capturedDdl: string[] = [];
    const capturedStoredProcs: string[] = [];

    t.mock.module("../../dist/db/ladybug-core.js", {
      namedExports: {
        ...core,
        exec: async () => undefined,
        execDdl: async (_conn: Connection, statement: string) => {
          capturedDdl.push(statement);
        },
        execStoredProc: async (_conn: Connection, statement: string) => {
          capturedStoredProcs.push(statement);
        },
        querySingle: async () => ({ count: 1n, rowCount: 1n }),
        queryStoredProcAll: async () => [],
      },
    });
    t.mock.module("../../dist/db/extension-caps.js", {
      namedExports: {
        ...caps,
        getExtensionCapabilities: () => ({ fts: true, vector: true }),
      },
    });

    const schema = await import(
      "../../dist/db/ladybug-schema.js?fresh-vector-layout"
    );
    const lifecycle = await import(
      "../../dist/retrieval/index-lifecycle.js?fresh-vector-layout"
    );
    const conn = {} as Connection;

    await schema.createBaseSchema(conn);
    await schema.createSecondaryIndexes(conn);
    await lifecycle.ensureIndexes(
      conn,
      {
        vector: {
          enabled: true,
          indexes: {
            "jina-embeddings-v2-base-code": {
              indexName: "symbol_vec_jina_code_v2",
            },
            "nomic-embed-text-v1.5": {
              indexName: "symbol_vec_nomic_embed_v15",
            },
          },
        },
      } as never,
    );
    await lifecycle.ensureEntityIndexes(conn, {
      includeAgentFeedbackVectorIndexes: false,
    });

    const nodeTables = capturedDdl.flatMap((statement) => {
      const match = statement.match(
        /^CREATE NODE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/,
      );
      return match?.[1] ? [match[1]] : [];
    });
    assert.ok(nodeTables.includes("Symbol"));
    assert.ok(nodeTables.includes("FileSummary"));
    assert.ok(!nodeTables.includes("SymbolVectorEmbedding"));
    assert.ok(
      capturedDdl.includes(
        "CREATE INDEX idx_filesummary_repoId ON FileSummary(repoId)",
      ),
    );

    const vectorCreates = capturedStoredProcs.filter((statement) =>
      statement.includes("CREATE_VECTOR_INDEX"),
    );
    assert.deepEqual(
      vectorCreates.filter((statement) => statement.includes("'FileSummary'")),
      [
        "CALL CREATE_VECTOR_INDEX('FileSummary', 'filesummary_vec_jina_code_v2', 'embeddingJinaCodeVec', metric := 'cosine', efc := 200)",
        "CALL CREATE_VECTOR_INDEX('FileSummary', 'filesummary_vec_nomic_embed_v15', 'embeddingNomicVec', metric := 'cosine', efc := 200)",
      ],
    );
    assert.equal(
      vectorCreates.filter((statement) => !statement.includes("'FileSummary'"))
        .length,
      0,
    );
    assert.ok(
      capturedStoredProcs.includes(
        "CALL CREATE_FTS_INDEX('FileSummary', 'filesummary_search_text_v1', ['searchText'])",
      ),
    );
  });
});
