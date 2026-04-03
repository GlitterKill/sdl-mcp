import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  routeSymbolCardApiRequest,
  type HttpApiRequest,
} from "../../dist/cli/transport/http.js";

describe("symbol card HTTP routing", () => {
  it("passes If-None-Match through to the symbol card handler", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const response = await routeSymbolCardApiRequest(
      {
        method: "GET",
        pathname: "/api/symbol/demo-repo/card/sym-1",
        headers: {
          "if-none-match": "etag-123",
        },
      } satisfies HttpApiRequest,
      {
        async symbolGetCard(payload) {
          calls.push(payload as Record<string, unknown>);
          return {
            notModified: true,
            etag: "etag-123",
            ledgerVersion: "v1",
          };
        },
      },
    );

    assert.ok(response);
    assert.strictEqual(response?.status, 304);
    assert.deepStrictEqual(calls, [
      {
        repoId: "demo-repo",
        symbolId: "sym-1",
        ifNoneMatch: "etag-123",
      },
    ]);
  });

  it("accepts standard-cased If-None-Match headers", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const response = await routeSymbolCardApiRequest(
      {
        method: "GET",
        pathname: "/api/symbol/demo-repo/card/sym-1",
        headers: {
          "If-None-Match": "etag-456",
        },
      } satisfies HttpApiRequest,
      {
        async symbolGetCard(payload) {
          calls.push(payload as Record<string, unknown>);
          return {
            notModified: true,
            etag: "etag-456",
            ledgerVersion: "v1",
          };
        },
      },
    );

    assert.ok(response);
    assert.strictEqual(response?.status, 304);
    assert.deepStrictEqual(calls, [
      {
        repoId: "demo-repo",
        symbolId: "sym-1",
        ifNoneMatch: "etag-456",
      },
    ]);
  });
});
