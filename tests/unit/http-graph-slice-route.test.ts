import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraphForSliceHandle,
} from "../../dist/cli/transport/http.js";

test("slice graph construction uses the slice handle version bounds", async () => {
  const calls: Array<
    | { kind: "preview" }
    | {
        kind: "blast";
        fromVersion: string;
        toVersion: string;
        maxNodes: number;
      }
  > = [];

  const graph = await buildGraphForSliceHandle(
    {} as unknown as import("kuzu").Connection,
    "repo-1",
    "handle-1",
    42,
    {
      async getSliceHandle() {
        return {
          handle: "handle-1",
          repoId: "repo-1",
          createdAt: "2026-03-18T00:00:00.000Z",
          expiresAt: "2026-03-19T00:00:00.000Z",
          minVersion: "v1",
          maxVersion: "v2",
          sliceHash: "slice-hash",
          spilloverRef: null,
        };
      },
      async buildRepoPreview() {
        calls.push({ kind: "preview" });
        return { nodes: [{ id: "preview" }], links: [] };
      },
      async buildBlastRadiusGraph(_conn, _repoId, fromVersion, toVersion, maxNodes) {
        calls.push({
          kind: "blast",
          fromVersion,
          toVersion,
          maxNodes,
        });
        return { nodes: [{ id: "blast" }], links: [] };
      },
    },
  );

  assert.deepStrictEqual(calls, [
    {
      kind: "blast",
      fromVersion: "v1",
      toVersion: "v2",
      maxNodes: 42,
    },
  ]);
  assert.strictEqual(graph.nodes[0]?.id, "blast");
});
