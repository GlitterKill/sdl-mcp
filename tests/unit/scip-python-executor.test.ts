import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeProviderFirstScipFull } from "../../dist/indexer/provider-first/executor.js";
import {
  ScipConfigSchema,
  IndexingConfigSchema,
  type AppConfig,
} from "../../dist/config/types.js";
import { logger } from "../../dist/util/logger.js";
import { writeTestScipIndex } from "../fixtures/scip/builder.ts";

test("SCIP executor collects Python worker proof, including multiline-only documents, and shuts down quietly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sdl-python-executor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings = t.mock.method(logger, "warn", () => {});
  const target = "scip-python python fixture 1 original/original().";
  const owner = "scip-python python fixture 1 caller/run().";
  const value = "scip-python python fixture 1 values/value.";
  const thing = "scip-python python fixture 1 original/Thing#";
  await writeFile(
    join(root, "caller.py"),
    "from facade import original as alias\ndef run():\n    alias()\n",
  );
  await writeFile(join(root, "values.py"), "value = (\n Thing\n)\n");
  await writeTestScipIndex(join(root, "index.scip"), {
    metadata: { toolName: "scip-python", toolVersion: "fixture" },
    documents: [
      {
        language: "python",
        relativePath: "caller.py",
        symbols: [{ symbol: owner, kind: 17, displayName: "run" }],
        occurrences: [
          { symbol: target, range: [0, 19, 36], symbolRoles: 8 },
          {
            symbol: owner,
            range: [1, 4, 7],
            enclosingRange: [1, 0, 3, 0],
            symbolRoles: 1,
          },
          { symbol: target, range: [2, 4, 9], symbolRoles: 8 },
        ],
      },
      {
        language: "python",
        relativePath: "values.py",
        symbols: [{ symbol: value, displayName: "value" }],
        occurrences: [
          { symbol: value, range: [0, 0, 5], symbolRoles: 1 },
          { symbol: thing, range: [0, 8, 2, 1], symbolRoles: 8 },
        ],
      },
    ],
    externalSymbols: [
      { symbol: target, kind: 17, displayName: "original" },
      { symbol: thing, kind: 7, displayName: "Thing" },
    ],
  });
  const config = {
    scip: ScipConfigSchema.parse({
      enabled: true,
      indexes: [{ path: "index.scip" }],
    }),
    indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
    repos: [{ repoId: "python-executor", rootPath: root }],
  } as AppConfig;
  // Match the retained run's fifteen short-lived collections without a live benchmark.
  for (let i = 0; i < 15; i++) {
    const result = await executeProviderFirstScipFull({
      repoId: "python-executor",
      repoRoot: root,
      config,
      disableProviderCollectionCache: true,
    });
    assert.equal(
      result.facts.edges.filter((edge) => edge.edgeType === "call").length,
      1,
    );
    assert.equal(
      result.facts.coverage.find((c) => c.relPath === "caller.py")
        ?.callProofUnavailableReferences,
      0,
    );
    assert.equal(
      result.facts.coverage.find((c) => c.relPath === "values.py")
        ?.callProofUnavailableReferences,
      0,
    );
  }
  assert.equal(
    warnings.mock.calls.filter(
      (call) => call.arguments[0] === "Worker crashed and was replaced",
    ).length,
    0,
  );
});
