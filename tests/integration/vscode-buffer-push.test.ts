import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — vscode extension source has no type declarations
import { createLiveSyncClient } from "../../sdl-mcp-vscode/dist/live-sync.js";

describe("VS Code live buffer sync client", () => {
  it("posts buffer updates to the live buffer endpoint", async () => {
    const requests: Array<{ url: string; options?: RequestInit }> = [];
    const client = createLiveSyncClient({
      requestJson: async (url: string, options: RequestInit) => {
        requests.push({ url, options });
        return { accepted: true };
      },
    });

    await client.pushBufferEvent(
      {
        serverUrl: "http://localhost:3000",
        repoId: "demo-repo",
        enableOnSaveReindex: true,
      },
      {
        eventType: "change",
        filePath: "src/example.ts",
        content: "export const value = 1;",
        language: "typescript",
        version: 3,
        dirty: true,
        timestamp: "2026-03-07T12:00:00.000Z",
      },
    );

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(
      requests[0]?.url,
      "http://localhost:3000/api/repo/demo-repo/buffer",
    );
    assert.strictEqual(requests[0]?.options?.method, "POST");
  });

  it("falls back to incremental reindex when save push fails", async () => {
    const requests: Array<{ url: string; options?: RequestInit }> = [];
    const client = createLiveSyncClient({
      requestJson: async (url: string, options: RequestInit) => {
        requests.push({ url, options });
        if (url.endsWith("/buffer")) {
          throw new Error("404");
        }
        return { ok: true };
      },
    });

    await client.pushSaveWithFallback(
      {
        serverUrl: "http://localhost:3000",
        repoId: "demo-repo",
        enableOnSaveReindex: true,
      },
      {
        filePath: "src/example.ts",
        content: "export const value = 1;",
        language: "typescript",
        version: 4,
        dirty: false,
        timestamp: "2026-03-07T12:00:00.000Z",
      },
    );

    assert.deepStrictEqual(
      requests.map((entry) => entry.url),
      [
        "http://localhost:3000/api/repo/demo-repo/buffer",
        "http://localhost:3000/api/repo/demo-repo/reindex",
      ],
    );
    assert.strictEqual(requests[1]?.options?.method, "POST");
  });
});
