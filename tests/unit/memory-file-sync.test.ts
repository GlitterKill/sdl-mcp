import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  writeMemoryFile,
  readMemoryFile,
  scanMemoryFiles,
  deleteMemoryFile,
  updateMemoryFileFrontmatter,
  parseMemoryFileContent,
  type MemoryFileData,
} from "../../src/memory/file-sync.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sdl-memory-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const sampleMemory: MemoryFileData = {
  memoryId: "abc123def456",
  type: "decision",
  title: "Chose LadybugDB over SQLite",
  content:
    "## Context\nWe needed multi-hop graph traversal for slice building.\n\n## Decision\nLadybugDB chosen for Cypher queries.",
  tags: ["database", "architecture"],
  confidence: 0.9,
  symbols: ["sym_a", "sym_b"],
  files: ["src/db/ladybug.ts"],
  createdAt: "2026-03-13T10:30:00Z",
  deleted: false,
};

describe("memory file-sync", () => {
  test("writeMemoryFile creates file with YAML frontmatter", async () => {
    const tmpDir = createTmpDir();
    try {
      const relPath = await writeMemoryFile(tmpDir, sampleMemory);
      assert.ok(relPath.includes(".sdl-memory/decisions/abc123def456.md"));
      const fullPath = path.join(tmpDir, relPath);
      assert.ok(fs.existsSync(fullPath));
      const raw = fs.readFileSync(fullPath, "utf-8");
      assert.ok(raw.startsWith("---\n"));
      assert.ok(raw.includes("memoryId: abc123def456"));
      assert.ok(raw.includes("type: decision"));
      assert.ok(raw.includes("confidence: 0.9"));
      assert.ok(raw.includes("tags: [database, architecture]"));
      assert.ok(raw.includes("## Context"));
    } finally {
      cleanup(tmpDir);
    }
  });

  test("readMemoryFile round-trips correctly", async () => {
    const tmpDir = createTmpDir();
    try {
      const relPath = await writeMemoryFile(tmpDir, sampleMemory);
      const fullPath = path.join(tmpDir, relPath);
      const data = await readMemoryFile(fullPath);
      assert.ok(data);
      assert.strictEqual(data.memoryId, "abc123def456");
      assert.strictEqual(data.type, "decision");
      assert.strictEqual(data.title, "Chose LadybugDB over SQLite");
      assert.strictEqual(data.confidence, 0.9);
      assert.deepStrictEqual(data.tags, ["database", "architecture"]);
      assert.deepStrictEqual(data.symbols, ["sym_a", "sym_b"]);
      assert.deepStrictEqual(data.files, ["src/db/ladybug.ts"]);
      assert.strictEqual(data.deleted, false);
      assert.ok(data.content.includes("## Context"));
    } finally {
      cleanup(tmpDir);
    }
  });

  test("readMemoryFile returns null for non-existent file", async () => {
    const result = await readMemoryFile("/nonexistent/path/memory.md");
    assert.strictEqual(result, null);
  });

  test("parseMemoryFileContent handles malformed frontmatter", () => {
    const result = parseMemoryFileContent("no frontmatter here");
    assert.strictEqual(result, null);
  });

  test("parseMemoryFileContent handles missing required fields", () => {
    const raw = "---\ntitle: no id\n---\nsome content";
    const result = parseMemoryFileContent(raw);
    assert.strictEqual(result, null);
  });

  test("parseMemoryFileContent handles empty arrays", () => {
    const raw =
      "---\nmemoryId: test123\ntype: bugfix\ntitle: Fix\ntags: []\nsymbols: []\nfiles: []\nconfidence: 0.5\ncreatedAt: 2026-01-01T00:00:00Z\ndeleted: false\n---\nBody";
    const result = parseMemoryFileContent(raw);
    assert.ok(result);
    assert.deepStrictEqual(result.tags, []);
    assert.deepStrictEqual(result.symbols, []);
    assert.deepStrictEqual(result.files, []);
  });

  test("parseMemoryFileContent handles deleted flag", () => {
    const raw =
      "---\nmemoryId: del123\ntype: decision\ntitle: Old\ntags: []\nsymbols: []\nfiles: []\nconfidence: 0.8\ncreatedAt: 2026-01-01T00:00:00Z\ndeleted: true\n---\nOld content";
    const result = parseMemoryFileContent(raw);
    assert.ok(result);
    assert.strictEqual(result.deleted, true);
  });

  test("scanMemoryFiles returns empty for missing directory", async () => {
    const tmpDir = createTmpDir();
    try {
      const files = await scanMemoryFiles(tmpDir);
      assert.deepStrictEqual(files, []);
    } finally {
      cleanup(tmpDir);
    }
  });

  test("scanMemoryFiles finds files recursively", async () => {
    const tmpDir = createTmpDir();
    try {
      await writeMemoryFile(tmpDir, sampleMemory);
      await writeMemoryFile(tmpDir, {
        ...sampleMemory,
        memoryId: "xyz789",
        type: "bugfix",
      });
      const files = await scanMemoryFiles(tmpDir);
      assert.strictEqual(files.length, 2);
      assert.ok(files.some((f) => f.includes("abc123def456.md")));
      assert.ok(files.some((f) => f.includes("xyz789.md")));
    } finally {
      cleanup(tmpDir);
    }
  });

  test("deleteMemoryFile removes file", async () => {
    const tmpDir = createTmpDir();
    try {
      await writeMemoryFile(tmpDir, sampleMemory);
      const deleted = await deleteMemoryFile(
        tmpDir,
        "decision",
        "abc123def456",
      );
      assert.strictEqual(deleted, true);
      const files = await scanMemoryFiles(tmpDir);
      assert.strictEqual(files.length, 0);
    } finally {
      cleanup(tmpDir);
    }
  });

  test("deleteMemoryFile returns false for non-existent", async () => {
    const tmpDir = createTmpDir();
    try {
      const deleted = await deleteMemoryFile(tmpDir, "decision", "nonexistent");
      assert.strictEqual(deleted, false);
    } finally {
      cleanup(tmpDir);
    }
  });

  test("updateMemoryFileFrontmatter updates deleted flag", async () => {
    const tmpDir = createTmpDir();
    try {
      const relPath = await writeMemoryFile(tmpDir, sampleMemory);
      const fullPath = path.join(tmpDir, relPath);
      await updateMemoryFileFrontmatter(fullPath, { deleted: true });
      const data = await readMemoryFile(fullPath);
      assert.ok(data);
      assert.strictEqual(data.deleted, true);
      // Body should be preserved
      assert.ok(data.content.includes("## Context"));
    } finally {
      cleanup(tmpDir);
    }
  });

  test("updateMemoryFileFrontmatter updates confidence", async () => {
    const tmpDir = createTmpDir();
    try {
      const relPath = await writeMemoryFile(tmpDir, sampleMemory);
      const fullPath = path.join(tmpDir, relPath);
      await updateMemoryFileFrontmatter(fullPath, { confidence: 0.5 });
      const data = await readMemoryFile(fullPath);
      assert.ok(data);
      assert.strictEqual(data.confidence, 0.5);
    } finally {
      cleanup(tmpDir);
    }
  });

  test("handles BOM in file", async () => {
    const tmpDir = createTmpDir();
    try {
      const relPath = await writeMemoryFile(tmpDir, sampleMemory);
      const fullPath = path.join(tmpDir, relPath);
      // Prepend BOM
      const content = fs.readFileSync(fullPath, "utf-8");
      fs.writeFileSync(fullPath, "\uFEFF" + content, "utf-8");
      const data = await readMemoryFile(fullPath);
      assert.ok(data);
      assert.strictEqual(data.memoryId, "abc123def456");
    } finally {
      cleanup(tmpDir);
    }
  });

  test("handles title with special characters", async () => {
    const tmpDir = createTmpDir();
    try {
      const special: MemoryFileData = {
        ...sampleMemory,
        memoryId: "special123",
        title: 'Config: use "strict" mode & enable [feature]',
      };
      const relPath = await writeMemoryFile(tmpDir, special);
      const fullPath = path.join(tmpDir, relPath);
      const data = await readMemoryFile(fullPath);
      assert.ok(data);
      assert.strictEqual(
        data.title,
        'Config: use "strict" mode & enable [feature]',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test("bugfix type maps to bugfixes directory", async () => {
    const tmpDir = createTmpDir();
    try {
      const relPath = await writeMemoryFile(tmpDir, {
        ...sampleMemory,
        memoryId: "bugfix1",
        type: "bugfix",
      });
      assert.ok(relPath.includes("bugfixes/bugfix1.md"));
    } finally {
      cleanup(tmpDir);
    }
  });

  test("task_context type maps to task_context directory", async () => {
    const tmpDir = createTmpDir();
    try {
      const relPath = await writeMemoryFile(tmpDir, {
        ...sampleMemory,
        memoryId: "task1",
        type: "task_context",
      });
      assert.ok(relPath.includes("task_context/task1.md"));
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("memory Zod schemas", () => {
  test("MemoryStoreRequestSchema validates correct input", async () => {
    const { MemoryStoreRequestSchema } = await import("../../src/mcp/tools.js");
    const result = MemoryStoreRequestSchema.safeParse({
      repoId: "test-repo",
      type: "decision",
      title: "Test decision",
      content: "Some content",
      tags: ["tag1"],
      confidence: 0.8,
    });
    assert.ok(result.success);
  });

  test("MemoryStoreRequestSchema rejects invalid type", async () => {
    const { MemoryStoreRequestSchema } = await import("../../src/mcp/tools.js");
    const result = MemoryStoreRequestSchema.safeParse({
      repoId: "test-repo",
      type: "invalid_type",
      title: "Test",
      content: "Content",
    });
    assert.ok(!result.success);
  });

  test("MemoryStoreRequestSchema rejects title over 120 chars", async () => {
    const { MemoryStoreRequestSchema } = await import("../../src/mcp/tools.js");
    const result = MemoryStoreRequestSchema.safeParse({
      repoId: "test-repo",
      type: "decision",
      title: "x".repeat(121),
      content: "Content",
    });
    assert.ok(!result.success);
  });

  test("MemoryQueryRequestSchema validates with optional fields", async () => {
    const { MemoryQueryRequestSchema } = await import("../../src/mcp/tools.js");
    const result = MemoryQueryRequestSchema.safeParse({
      repoId: "test-repo",
    });
    assert.ok(result.success);
  });

  test("MemoryQueryRequestSchema validates with all filters", async () => {
    const { MemoryQueryRequestSchema } = await import("../../src/mcp/tools.js");
    const result = MemoryQueryRequestSchema.safeParse({
      repoId: "test-repo",
      query: "auth",
      types: ["decision", "bugfix"],
      tags: ["security"],
      staleOnly: true,
      limit: 10,
      sortBy: "confidence",
    });
    assert.ok(result.success);
  });

  test("MemorySurfaceRequestSchema validates with symbolIds", async () => {
    const { MemorySurfaceRequestSchema } =
      await import("../../src/mcp/tools.js");
    const result = MemorySurfaceRequestSchema.safeParse({
      repoId: "test-repo",
      symbolIds: ["sym_1", "sym_2"],
      taskType: "bugfix",
      limit: 5,
    });
    assert.ok(result.success);
  });
});
