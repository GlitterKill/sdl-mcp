import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../dist/config/loadConfig.js";

import { DatabaseError } from "../../dist/domain/errors.js";
import {
  _setDeferredIndexesPendingForTesting,
  buildDeferredIndexes,
  hasDeferredIndexes,
  type BuildDeferredIndexesDependencies,
} from "../../dist/db/ladybug.js";

function createDependencies(
  failedIndexes: readonly string[],
): BuildDeferredIndexesDependencies {
  const fakeConn =
    {} as Parameters<BuildDeferredIndexesDependencies["createSecondaryIndexes"]>[0];

  return {
    withWriteConn: async (fn) => fn(fakeConn),
    createSecondaryIndexes: async () => {},
    loadConfig: () =>
      ({
        semantic: {
          enabled: true,
          retrieval: {
            fts: { enabled: true, indexName: "symbol_search_text_v1" },
          },
        },
      }) as ReturnType<BuildDeferredIndexesDependencies["loadConfig"]>,
    loadRetrievalIndexDependencies: async () => ({
      ensureIndexes: async () => ({
        created: [],
        skipped: [],
        failed: [...failedIndexes],
      }),
      ensureEntityIndexes: async () => ({
        created: [],
        skipped: [],
        failed: [],
      }),
    }),
  };
}

describe("deferred retrieval index bootstrap", () => {
  afterEach(() => {
    _setDeferredIndexesPendingForTesting(false);
  });

  it("requests retrieval indexes when a minimal config omits semantic.retrieval (#53)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdl-default-bootstrap-"));
    try {
      const configPath = join(dir, "sdlmcp.config.json");
      writeFileSync(configPath, JSON.stringify({ repos: [], policy: {} }));
      const dependencies = createDependencies([]);
      dependencies.loadConfig = () => loadConfig(configPath);
      const retrieval = await dependencies.loadRetrievalIndexDependencies();
      let calls = 0;
      dependencies.loadRetrievalIndexDependencies = async () => ({
        ...retrieval,
        ensureIndexes: async (_conn, config) => {
          calls++;
          assert.equal(config.fts.enabled, true);
          assert.equal(config.vector.enabled, true);
          return { created: [], skipped: [], failed: [] };
        },
      });
      _setDeferredIndexesPendingForTesting(true);
      await buildDeferredIndexes({ _dependenciesForTesting: dependencies });
      assert.equal(calls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects failed required retrieval indexes and keeps retry pending", async () => {
    _setDeferredIndexesPendingForTesting(true);

    await assert.rejects(
      () =>
        buildDeferredIndexes({
          _dependenciesForTesting: createDependencies(["symbol_search_text_v1"]),
        }),
      (err: unknown) => {
        assert.ok(err instanceof DatabaseError);
        assert.match(err.message, /symbol_search_text_v1/);
        return true;
      },
    );

    assert.equal(hasDeferredIndexes(), true);
  });

  it("clears retry pending after successful deferred index bootstrap", async () => {
    _setDeferredIndexesPendingForTesting(true);

    await buildDeferredIndexes({
      _dependenciesForTesting: createDependencies([]),
    });

    assert.equal(hasDeferredIndexes(), false);
  });
});
