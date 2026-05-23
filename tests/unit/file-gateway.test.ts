import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FileGatewayRequestSchema,
  handleFileGateway,
} from "../../dist/mcp/tools/file-gateway.js";
import { getSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";

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

    it("parses identifier preview targeting", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "searchEditPreview",
        repoId: "test-repo",
        targeting: "identifier",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { include: ["src/**/*.ts"] },
      });
      assert.equal(result.op, "searchEditPreview");
      assert.equal(result.targeting, "identifier");
    });

    it("parses preview with operations batch", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "searchEditPreview",
        repoId: "test-repo",
        operations: [
          {
            id: "one",
            targeting: "text",
            query: { literal: "foo", replacement: "bar" },
            editMode: "replacePattern",
            filters: { include: ["src/a.ts"] },
          },
          {
            id: "two",
            targeting: "text",
            query: { literal: "baz", replacement: "qux" },
            editMode: "replacePattern",
            filters: { include: ["src/b.ts"] },
          },
        ],
      });

      assert.equal(result.op, "searchEditPreview");
      assert.equal(result.operations.length, 2);
      assert.equal(result.operations[0].id, "one");
    });

    it("parses structural targeting inside operations batch", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "searchEditPreview",
        repoId: "test-repo",
        operations: [
          {
            id: "call-rename",
            targeting: "structural",
            query: {
              structural: {
                language: "python",
                treeSitterQuery: "(identifier) @target",
                requiredCaptures: { target: "old_name" },
              },
              replacement: "newName()",
            },
            editMode: "replacePattern",
            filters: { include: ["src/a.ts"] },
          },
        ],
      });

      assert.equal(result.op, "searchEditPreview");
      assert.equal(result.operations[0].targeting, "structural");
      assert.equal(result.operations[0].query.structural?.language, "python");
    });

    it("rejects structural requiredCaptures maps with unsafe or excessive keys", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "searchEditPreview",
          repoId: "test-repo",
          targeting: "structural",
          query: {
            structural: {
              treeSitterQuery: "(identifier) @target",
              requiredCaptures: Object.fromEntries(
                Array.from({ length: 33 }, (_, index) => [
                  `capture_${index}`,
                  "old_name",
                ]),
              ),
            },
          },
          editMode: "replacePattern",
        });
      }, /requiredCaptures may include at most 32 entries/);

      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "searchEditPreview",
          repoId: "test-repo",
          targeting: "structural",
          query: {
            structural: {
              treeSitterQuery: "(identifier) @target",
              requiredCaptures: JSON.parse('{"constructor":"old_name"}'),
            },
          },
          editMode: "replacePattern",
        });
      }, /Blocked requiredCaptures key/);
    });

    it("rejects operations batch with duplicate ids", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "searchEditPreview",
          repoId: "test-repo",
          operations: [
            {
              id: "rename",
              targeting: "text",
              query: { literal: "foo", replacement: "bar" },
              editMode: "replacePattern",
            },
            {
              id: "rename",
              targeting: "text",
              query: { literal: "baz", replacement: "qux" },
              editMode: "replacePattern",
            },
          ],
        });
      }, /duplicate/i);
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

  describe("op: symbolEdit", () => {
    it("accepts long symbolId values matching the flat symbol.edit schema", () => {
      const longSymbolId =
        "src/" + "deep/".repeat(70) + "module.ts::targetSymbol";
      assert.equal(longSymbolId.length > 200, true);

      const preview = FileGatewayRequestSchema.parse({
        op: "symbolEditPreview",
        repoId: "test-repo",
        symbolId: longSymbolId,
        operation: { kind: "replaceSymbol", content: "export const next = 1;" },
      });
      const applyNow = FileGatewayRequestSchema.parse({
        op: "symbolEditApplyNow",
        repoId: "test-repo",
        symbolId: longSymbolId,
        expectedAstFingerprint: "fp-1",
        expectedRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 22 },
        operation: { kind: "replaceSymbol", content: "export const next = 1;" },
      });

      assert.equal(preview.op, "symbolEditPreview");
      assert.equal(preview.symbolId, longSymbolId);
      assert.equal(applyNow.op, "symbolEditApplyNow");
      assert.equal(applyNow.symbolId, longSymbolId);
    });
  });

  describe("op: previewWindow/sourceWindow", () => {
    it("parses a plan-bound previewWindow request", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "previewWindow",
        repoId: "test-repo",
        planHandle: "plan-abc-123",
        filePath: "src/index.ts",
        symbolId: "symbol-123",
        reason: "Inspect the planned edit before applying it",
        expectedLines: 12,
        identifiersToFind: ["target"],
        granularity: "fileWindow",
        responseMode: "inline",
      });

      assert.equal(result.op, "previewWindow");
      assert.equal(result.planHandle, "plan-abc-123");
      assert.equal(result.filePath, "src/index.ts");
      assert.equal(result.symbolId, "symbol-123");
    });

    it("parses previewWindow without symbolId so the handler can return plan-aware guidance", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "previewWindow",
        repoId: "test-repo",
        planHandle: "plan-abc-123",
        filePath: "src/index.ts",
        reason: "Inspect the planned edit before applying it",
        expectedLines: 12,
        identifiersToFind: ["target"],
      });

      assert.equal(result.op, "previewWindow");
      assert.equal(result.symbolId, undefined);
    });

    it("parses sourceWindow as an alias for the same gated path", () => {
      const result = FileGatewayRequestSchema.parse({
        op: "sourceWindow",
        repoId: "test-repo",
        planHandle: "plan-abc-123",
        symbolId: "symbol-123",
        reason: "Inspect the planned edit before applying it",
        expectedLines: 12,
        identifiersToFind: ["target"],
        responseMode: "inline",
      });

      assert.equal(result.op, "sourceWindow");
      assert.equal(result.planHandle, "plan-abc-123");
    });

    it("rejects previewWindow without a planHandle", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "previewWindow",
          repoId: "test-repo",
          symbolId: "symbol-123",
          reason: "Inspect the planned edit before applying it",
          expectedLines: 12,
          identifiersToFind: ["target"],
          responseMode: "inline",
        });
      });
    });

    it("rejects sourceWindow without a planHandle", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "sourceWindow",
          repoId: "test-repo",
          symbolId: "symbol-123",
          reason: "Inspect source after previewing an edit",
          expectedLines: 12,
          identifiersToFind: ["target"],
          responseMode: "inline",
        });
      });
    });

    it("rejects previewWindow filePath with null byte", () => {
      assert.throws(() => {
        FileGatewayRequestSchema.parse({
          op: "previewWindow",
          repoId: "test-repo",
          planHandle: "plan-abc-123",
          filePath: "src/\0index.ts",
          symbolId: "symbol-123",
          reason: "Inspect the planned edit before applying it",
          expectedLines: 12,
          identifiersToFind: ["target"],
          responseMode: "inline",
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
      () =>
        handleFileGateway({
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
      () =>
        handleFileGateway({
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
      () =>
        handleFileGateway({
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

  it("op:searchEditPreview dispatch accepts identifier targeting", async () => {
    await assert.rejects(
      () =>
        handleFileGateway({
          op: "searchEditPreview",
          repoId: "nonexistent-test-repo",
          targeting: "identifier",
          query: { literal: "oldName", replacement: "newName", global: true },
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
      () =>
        handleFileGateway({
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

  it("op:previewWindow dispatches to the plan-bound window handler", async () => {
    await assert.rejects(
      () =>
        handleFileGateway({
          op: "previewWindow",
          repoId: "test-repo",
          planHandle: "plan-fake-123",
          symbolId: "symbol-123",
          reason: "Inspect the planned edit before applying it",
          expectedLines: 12,
          identifiersToFind: ["target"],
          responseMode: "inline",
        }),
      (err: any) => {
        assert.notEqual(err?.constructor?.name, "ZodError");
        assert.match(
          String(err?.message ?? ""),
          /Edit plan not found or expired/,
        );
        return true;
      },
    );
  });

  it("op:previewWindow without symbolId reports plan-aware guidance", async () => {
    const store = getSearchEditPlanStore();
    const plan = store.create(
      "test-repo",
      [
        {
          relPath: "src/index.ts",
          absPath: "F:/repo/src/index.ts",
          newContent: "const target = true;",
          createBackup: false,
          fileExists: true,
          indexedSource: true,
          matchCount: 1,
          editMode: "replacePattern",
        },
      ],
      [],
      { fileEntries: [{ file: "src/index.ts", snippets: [] }] },
      false,
    );

    try {
      await assert.rejects(
        () =>
          handleFileGateway({
            op: "previewWindow",
            repoId: "test-repo",
            planHandle: plan.planHandle,
            filePath: "src/index.ts",
            reason: "Inspect the planned edit before applying it",
            expectedLines: 12,
            identifiersToFind: ["target"],
            responseMode: "inline",
          }),
        (err: any) => {
          assert.notEqual(err?.constructor?.name, "ZodError");
          assert.match(
            String(err?.message ?? ""),
            /previewWindow requires symbolId.*Use symbol.search or symbol.getCard.*planHandle only constrains the file/s,
          );
          return true;
        },
      );
    } finally {
      store.remove(plan.planHandle);
    }
  });
  it("op:previewWindow without symbolId reaches plan validation instead of schema validation", async () => {
    await assert.rejects(
      () =>
        handleFileGateway({
          op: "previewWindow",
          repoId: "test-repo",
          planHandle: "plan-fake-123",
          reason: "Inspect the planned edit before applying it",
          expectedLines: 12,
          identifiersToFind: ["target"],
          responseMode: "inline",
        }),
      (err: any) => {
        assert.notEqual(err?.constructor?.name, "ZodError");
        assert.match(
          String(err?.message ?? ""),
          /Edit plan not found or expired/,
        );
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
