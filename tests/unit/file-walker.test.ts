import { describe, it } from "node:test";
import assert from "node:assert";
import { join, resolve } from "path";

import * as fileScannerModule from "../../dist/indexer/fileScanner.js";

type DirectoryEntryLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type DirectoryHandleLike = {
  read(): Promise<DirectoryEntryLike | null>;
  close(): Promise<void>;
};

type WalkRepositoryFilesFn = (
  repoPath: string,
  options: {
    patterns: string[];
    ignorePatterns?: string[];
    openDirectory?: (directoryPath: string) => Promise<DirectoryHandleLike>;
  },
) => Promise<string[]>;

function fileEntry(name: string): DirectoryEntryLike {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function directoryEntry(name: string): DirectoryEntryLike {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function createDirectoryHandle(
  entries: DirectoryEntryLike[],
  onClose: () => void,
): DirectoryHandleLike {
  let index = 0;
  let closed = false;

  return {
    async read(): Promise<DirectoryEntryLike | null> {
      if (closed) {
        throw new Error("directory already closed");
      }
      return entries[index++] ?? null;
    },
    async close(): Promise<void> {
      if (closed) {
        throw new Error("directory closed twice");
      }
      closed = true;
      onClose();
    },
  };
}

describe("fileScanner walkRepositoryFiles", () => {
  it("closes every opened directory handle while traversing nested trees", async () => {
    const walkRepositoryFiles = fileScannerModule
      .walkRepositoryFiles as WalkRepositoryFilesFn | undefined;

    assert.ok(
      walkRepositoryFiles,
      "Expected fileScanner to export walkRepositoryFiles for explicit directory traversal",
    );

    const repoPath = resolve("repo");
    const closedDirectories: string[] = [];
    const directories = new Map<string, DirectoryEntryLike[]>([
      [
        repoPath,
        [
          directoryEntry("src"),
          directoryEntry("node_modules"),
          fileEntry("root.ts"),
        ],
      ],
      [
        join(repoPath, "src"),
        [
          fileEntry("keep.ts"),
          fileEntry("skip.js"),
          directoryEntry("nested"),
        ],
      ],
      [
        join(repoPath, "src", "nested"),
        [
          fileEntry("child.ts"),
        ],
      ],
      [
        join(repoPath, "node_modules"),
        [
          directoryEntry("pkg"),
        ],
      ],
      [
        join(repoPath, "node_modules", "pkg"),
        [
          fileEntry("ignored.ts"),
        ],
      ],
    ]);

    const files = await walkRepositoryFiles(repoPath, {
      patterns: ["**/*.ts"],
      ignorePatterns: ["**/node_modules/**"],
      openDirectory: async (directoryPath) => {
        const entries = directories.get(directoryPath);
        assert.ok(entries, `Unexpected directory open: ${directoryPath}`);
        return createDirectoryHandle(entries, () => {
          closedDirectories.push(directoryPath);
        });
      },
    });

    assert.deepStrictEqual(files.sort(), [
      "root.ts",
      "src/keep.ts",
      "src/nested/child.ts",
    ]);
    assert.deepStrictEqual(closedDirectories.sort(), [
      repoPath,
      join(repoPath, "src"),
      join(repoPath, "src", "nested"),
    ]);
  });
});
