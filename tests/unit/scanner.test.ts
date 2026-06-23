import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isScannedFileChanged } from "../../dist/indexer/scanner.js";

describe("isScannedFileChanged", () => {
  it("uses matching content hash before mtime for incremental scans", () => {
    const contentHash = "a".repeat(64);
    const lastIndexedAt = new Date("2026-06-23T12:00:00.000Z").toISOString();
    const futureMtime = new Date("2026-06-23T12:00:01.000Z").getTime();

    assert.equal(
      isScannedFileChanged(
        {
          path: "src/example.ts",
          size: 12,
          mtime: futureMtime,
          contentHash,
        },
        {
          fileId: "file-1",
          repoId: "repo",
          relPath: "src/example.ts",
          contentHash,
          language: "typescript",
          byteSize: 12,
          lastIndexedAt,
          directory: "src",
        },
      ),
      false,
    );
  });

  it("treats content hash mismatch as changed", () => {
    assert.equal(
      isScannedFileChanged(
        {
          path: "src/example.ts",
          size: 12,
          mtime: new Date("2026-06-23T11:00:00.000Z").getTime(),
          contentHash: "b".repeat(64),
        },
        {
          fileId: "file-1",
          repoId: "repo",
          relPath: "src/example.ts",
          contentHash: "a".repeat(64),
          language: "typescript",
          byteSize: 12,
          lastIndexedAt: "2026-06-23T12:00:00.000Z",
          directory: "src",
        },
      ),
      true,
    );
  });
});
