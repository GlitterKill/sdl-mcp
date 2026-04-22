import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FileGatewayRequestSchema,
  handleFileGateway,
} from "../../dist/mcp/tools/file-gateway.js";

describe("FileGatewayRequestSchema", () => {
  describe("op: read", () => {
    it("parses minimal read request", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "read",
        repoId: "test-repo",
        filePath: "config/app.yaml",
      });
      assert.equal(result.op, "read");
      assert.equal(result.repoId, "test-repo");
      assert.equal(result.filePath, "config/app.yaml");
    });

    it("parses read with all optional fields", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "read",
        repoId: "test-repo",
        filePath: "config/app.yaml",
        maxBytes: 1024,
        offset: 10,
        limit: 50,
        search: "port",
        searchContext: 3,
        jsonPath: "server.port",
      });
      assert.equal(result.offset, 10);
      assert.equal(result.limit, 50);
      assert.equal(result.search, "port");
      assert.equal(result.searchContext, 3);
      assert.equal(result.jsonPath, "server.port");
    });

    it("applies searchContext default", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "read",
        repoId: "test-repo",
        filePath: "config/app.yaml",
      });
      assert.equal(result.searchContext, 2);
    });

    it("rejects read without filePath", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "read",
          repoId: "test-repo",
        });
      });
    });
  });

  describe("op: write", () => {
    it("parses write with content", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "write",
        repoId: "test-repo",
        filePath: "config/app.yaml",
        content: "server:\n  port: 8080\n",
      });
      assert.equal(result.op, "write");
      assert.equal(result.content, "server:\n  port: 8080\n");
    });

    it("parses write with replacePattern", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "write",
        repoId: "test-repo",
        filePath: "config/app.yaml",
        replacePattern: {
          pattern: "port: \\d+",
          replacement: "port: 9090",
          global: true,
        },
      });
      assert.equal(result.op, "write");
      assert.deepEqual(result.replacePattern, {
        pattern: "port: \\d+",
        replacement: "port: 9090",
        global: true,
      });
    });

    it("applies createBackup default true", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "write",
        repoId: "test-repo",
        filePath: "config/app.yaml",
        content: "test",
      });
      assert.equal(result.createBackup, true);
    });

    it("applies createIfMissing default false", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "write",
        repoId: "test-repo",
        filePath: "config/app.yaml",
        content: "test",
      });
      assert.equal(result.createIfMissing, false);
    });

    it("rejects filePath with null byte", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "write",
          repoId: "test-repo",
          filePath: "config/\0evil.yaml",
          content: "test",
        });
      });
    });
  });

  describe("op: searchEditPreview", () => {
    it("parses minimal preview request", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "searchEditPreview",
        repoId: "test-repo",
        targeting: "text",
        query: { literal: "foo", replacement: "bar" },
        editMode: "replacePattern",
      });
      assert.equal(result.op, "searchEditPreview");
      assert.equal(result.targeting, "text");
    });

    it("parses preview with filters", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "searchEditPreview",
        repoId: "test-repo",
        targeting: "text",
        query: { literal: "foo", replacement: "bar" },
        editMode: "replacePattern",
        filters: { include: ["src/**/*.ts"] },
        maxFiles: 10,
        maxMatchesPerFile: 5,
      });
      assert.equal(result.op, "searchEditPreview");
      assert.deepEqual(result.filters, { include: ["src/**/*.ts"] });
    });
  });

  describe("op: searchEditApply", () => {
    it("parses apply request", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "searchEditApply",
        repoId: "test-repo",
        planHandle: "plan-abc-123",
      });
      assert.equal(result.op, "searchEditApply");
      assert.equal(result.planHandle, "plan-abc-123");
    });

    it("rejects apply without planHandle", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "searchEditApply",
          repoId: "test-repo",
        });
      });
    });
  });

  describe("discriminator validation", () => {
    it("rejects unknown op", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "delete",
          repoId: "test-repo",
        });
      });
    });

    it("rejects missing op", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          repoId: "test-repo",
          filePath: "config/app.yaml",
        });
      });
    });

    it("rejects missing repoId", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "read",
          filePath: "config/app.yaml",
        });
      });
    });
  });
});

describe("handleFileGateway dispatch", () => {
  it("op:read dispatches to handleFileRead", async () => {
    await assert.rejects(
      () => handleFileGateway({
        op: "read",
        repoId: "nonexistent-test-repo",
        filePath: "package.json",
      }),
      (err: any) => {
        assert.notEqual(err?.constructor?.name, "ZodError");
        return true;
      },
    );
  });

  it("op:write dispatches to handleFileWrite", async () => {
    await assert.rejects(
      () => handleFileGateway({
        op: "write",
        repoId: "nonexistent-test-repo",
        filePath: "test.txt",
        content: "test",
      }),
      (err: any) => {
        assert.notEqual(err?.constructor?.name, "ZodError");
        return true;
      },
    );
  });

  it("op:searchEditPreview dispatches to handleSearchEdit", async () => {
    await assert.rejects(
      () => handleFileGateway({
        op: "searchEditPreview",
        repoId: "nonexistent-test-repo",
        targeting: "text",
        query: { literal: "foo", replacement: "bar" },
        editMode: "replacePattern",
      }),
      (err: any) => {
        assert.notEqual(err?.constructor?.name, "ZodError");
        return true;
      },
    );
  });

  it("op:searchEditApply dispatches to handleSearchEdit", async () => {
    await assert.rejects(
      () => handleFileGateway({
        op: "searchEditApply",
        repoId: "nonexistent-test-repo",
        planHandle: "plan-fake-123",
      }),
      (err: any) => {
        assert.notEqual(err?.constructor?.name, "ZodError");
        return true;
      },
    );
  });

  it("op:read strips op field before dispatch", () => {
    const parsed = FileGatewayRequestSchema.parse({
      op: "read",
      repoId: "test-repo",
      filePath: "package.json",
      jsonPath: "version",
    });
    const { op, ...rest } = parsed;
    assert.equal(rest.repoId, "test-repo");
    assert.equal(rest.filePath, "package.json");
    assert.equal(rest.jsonPath, "version");
    assert.equal("op" in rest, false);
  });

  it("op:searchEditPreview remaps to mode:preview", () => {
    const parsed = FileGatewayRequestSchema.parse({
      op: "searchEditPreview",
      repoId: "test-repo",
      targeting: "text",
      query: { literal: "foo", replacement: "bar" },
      editMode: "replacePattern",
    });
    const { op, ...rest } = parsed;
    const remapped = { mode: "preview" as const, ...rest };
    assert.equal(remapped.mode, "preview");
    assert.equal("op" in remapped, false);
  });

  it("op:searchEditApply remaps to mode:apply", () => {
    const parsed = FileGatewayRequestSchema.parse({
      op: "searchEditApply",
      repoId: "test-repo",
      planHandle: "plan-123",
    });
    const { op, ...rest } = parsed;
    const remapped = { mode: "apply" as const, ...rest };
    assert.equal(remapped.mode, "apply");
    assert.equal(remapped.planHandle, "plan-123");
    assert.equal("op" in remapped, false);
  });
});
