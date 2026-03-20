import assert from "node:assert";
import { describe, it } from "node:test";
import { z } from "zod";
import { normalizeToolArguments } from "../../src/mcp/request-normalization.js";
import { routeGatewayCall } from "../../src/gateway/router.js";

describe("request normalization", () => {
  it("normalizes snake_case and aliases to camelCase fields", () => {
    const normalized = normalizeToolArguments({
      repo_id: "repo-1",
      root_path: "/repo",
      symbol_ids: ["a", "b"],
      known_etags: { a: "1" },
      identifiers: ["thing"],
    }) as Record<string, unknown>;

    assert.deepStrictEqual(normalized, {
      repoId: "repo-1",
      rootPath: "/repo",
      symbolIds: ["a", "b"],
      knownEtags: { a: "1" },
      identifiersToFind: ["thing"],
    });
  });

  it("routes gateway calls after normalizing aliases", async () => {
    const actionMap = {
      "repo.register": {
        schema: z.object({
          repoId: z.string(),
          rootPath: z.string(),
        }),
        handler: async (args: unknown) => args,
      },
      "symbol.getCards": {
        schema: z.object({
          repoId: z.string(),
          symbolIds: z.array(z.string()).min(1),
        }),
        handler: async (args: unknown) => args,
      },
    };

    const repoResult = await routeGatewayCall(
      {
        action: "repo.register",
        repo: "repo-1",
        project_path: "/tmp/repo",
      },
      actionMap,
    );
    assert.deepStrictEqual(repoResult, {
      repoId: "repo-1",
      rootPath: "/tmp/repo",
    });

    const symbolResult = await routeGatewayCall(
      {
        action: "symbol.getCards",
        repo_id: "repo-1",
        symbol_ids: ["sym-1"],
      },
      actionMap,
    );
    assert.deepStrictEqual(symbolResult, {
      repoId: "repo-1",
      symbolIds: ["sym-1"],
    });
  });
});
