import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

import {
  getDerivedStateFromConnection,
  markEmbeddingLifecycleDeleting,
  markEmbeddingLifecycleRefreshingIfCurrent,
  markEmbeddingLifecycleSteadyIfCurrent,
} from "../../dist/db/ladybug-derived-state.js";

function fakeConnection(
  rows: Record<string, unknown>[],
  observed?: { statement?: string; params?: Record<string, unknown> },
): Connection {
  return {
    prepare: async (statement: string) => {
      if (observed) observed.statement = statement;
      return statement;
    },
    execute: async (_prepared: unknown, params: Record<string, unknown>) => {
      if (observed) observed.params = params;
      return {
        getAll: async () => rows,
        close: () => undefined,
      };
    },
  } as unknown as Connection;
}

describe("repository embedding lifecycle state", () => {
  it("normalizes steady, refreshing, and deleting", async () => {
    for (const lifecycle of ["steady", "refreshing", "deleting"] as const) {
      const row = await getDerivedStateFromConnection(
        fakeConnection([{ repoId: "repo", embeddingLifecycleState: lifecycle }]),
        "repo",
      );
      assert.equal(row?.embeddingLifecycleState, lifecycle);
    }
  });

  it("marks the current version dirty and refreshing, but refuses a stale version", async () => {
    const observed: {
      statement?: string;
      params?: Record<string, unknown>;
    } = {};
    assert.equal(
      await markEmbeddingLifecycleRefreshingIfCurrent(
        fakeConnection([{ repoId: "repo" }], observed),
        "repo",
        "v2",
      ),
      true,
    );
    assert.match(observed.statement ?? "", /d\.embeddingsDirty = true/u);
    assert.match(
      observed.statement ?? "",
      /d\.embeddingLifecycleState = 'refreshing'/u,
    );
    assert.equal(observed.params?.versionId, "v2");

    assert.equal(
      await markEmbeddingLifecycleRefreshingIfCurrent(
        fakeConnection([]),
        "repo",
        "stale",
      ),
      false,
    );
  });

  it("marks deletion dirty in one durable statement", async () => {
    const observed: {
      statement?: string;
      params?: Record<string, unknown>;
    } = {};
    await markEmbeddingLifecycleDeleting(
      fakeConnection([], observed),
      "repo",
    );
    assert.match(observed.statement ?? "", /d\.embeddingsDirty = true/u);
    assert.match(
      observed.statement ?? "",
      /d\.embeddingLifecycleState = 'deleting'/u,
    );
  });

  it("atomically clears embeddings and publishes steady only for the current version", async () => {
    const observed: {
      statement?: string;
      params?: Record<string, unknown>;
    } = {};
    assert.equal(
      await markEmbeddingLifecycleSteadyIfCurrent(
        fakeConnection([{ repoId: "repo" }], observed),
        "repo",
        "v2",
      ),
      true,
    );
    assert.match(observed.statement ?? "", /d\.embeddingsDirty = false/u);
    assert.match(
      observed.statement ?? "",
      /d\.embeddingLifecycleState = 'steady'/u,
    );
    assert.equal(observed.params?.versionId, "v2");

    assert.equal(
      await markEmbeddingLifecycleSteadyIfCurrent(
        fakeConnection([]),
        "repo",
        "stale",
      ),
      false,
    );
  });

  it("keeps the existing computed-state clear and steady transition atomic", () => {
    const source = readFileSync(
      new URL("../../src/db/ladybug-derived-state.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /d\.embeddingsDirty = CASE WHEN \$clearEmbeddings THEN false ELSE d\.embeddingsDirty END,[\s\S]*?d\.embeddingLifecycleState = CASE WHEN \$clearEmbeddings THEN 'steady' ELSE d\.embeddingLifecycleState END/u,
    );
  });
});
