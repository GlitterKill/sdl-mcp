import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMatrixGraphDbPath,
  buildMatrixRunEnv,
} from "../../src/benchmark/matrix-runner.js";

describe("benchmark matrix graph DB isolation", () => {
  it("builds a stable repo-scoped graph db path under the matrix output directory", () => {
    const graphDbPath = buildMatrixGraphDbPath("C:/tmp/matrix-out", "my-repo");

    assert.match(
      graphDbPath,
      /matrix-out[\\/]+graph-db[\\/]+my-repo[\\/]+sdl-mcp-graph\.lbug$/i,
    );
  });

  it("injects isolated graph db env vars for child benchmark runs", () => {
    const env = buildMatrixRunEnv(
      { EXISTING_FLAG: "1" },
      "C:/tmp/matrix-out",
      "repo-a",
    );

    assert.equal(env.EXISTING_FLAG, "1");
    assert.equal(env.SDL_GRAPH_DB_PATH, env.SDL_DB_PATH);
    assert.match(
      env.SDL_GRAPH_DB_PATH ?? "",
      /matrix-out[\\/]+graph-db[\\/]+repo-a[\\/]+sdl-mcp-graph\.lbug$/i,
    );
  });

  it("keeps distinct repo IDs on distinct graph db paths", () => {
    const slashPath = buildMatrixGraphDbPath("C:/tmp/matrix-out", "foo/bar");
    const underscorePath = buildMatrixGraphDbPath("C:/tmp/matrix-out", "foo_bar");

    assert.notEqual(slashPath, underscorePath);
    assert.match(slashPath, /foo%2Fbar[\\/]+sdl-mcp-graph\.lbug$/i);
    assert.match(underscorePath, /foo_bar[\\/]+sdl-mcp-graph\.lbug$/i);
  });
});
