import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatalog,
  rankCatalog,
  zodToSchemaSummary,
  invalidateCatalog,
} from "../../dist/code-mode/action-catalog.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { SearchEditRequestSchema } from "../../dist/mcp/tools.js";
import { z } from "zod";

const originalSdlConfig = process.env.SDL_CONFIG;

describe("code-mode action catalog", () => {
  let tmpDir: string;

  before(() => {
    // Create a config with memory enabled so all actions are present
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-catalog-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      repos: [{ repoId: "test", rootPath: tmpDir, memory: { enabled: true } }],
      policy: {},
    }));
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
  });

  after(() => {
    if (originalSdlConfig !== undefined) {
      process.env.SDL_CONFIG = originalSdlConfig;
    } else {
      delete process.env.SDL_CONFIG;
    }
    invalidateConfigCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("buildCatalog", () => {
    it("returns gateway actions and internal transforms", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      assert.ok(catalog.length > 0, "catalog should not be empty");

      const gatewayActions = catalog.filter((d) => d.kind === "gateway");
      const transforms = catalog.filter((d) => d.kind === "internal");
      const metaTools = catalog.filter((d) => d.kind === "meta");

      assert.ok(gatewayActions.length >= 29, `expected at least 29 gateway actions, got ${gatewayActions.length}`);
      assert.strictEqual(transforms.length, 6, "should have 6 internal transforms");
      assert.deepStrictEqual(
        metaTools.map((d) => d.action).sort(),
        ["action.search", "context", "file", "manual", "workflow"],
      );
    });

    it("each descriptor has action, fn, description, tags, kind", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.ok(desc.action, `action should be set for ${desc.fn}`);
        assert.ok(desc.fn, `fn should be set for ${desc.action}`);
        assert.ok(desc.description, `description should be set for ${desc.fn}`);
        assert.ok(Array.isArray(desc.tags), `tags should be an array for ${desc.fn}`);
        assert.ok(
          desc.kind === "gateway" || desc.kind === "internal" || desc.kind === "meta",
        );
      }
    });

    it("includes shared agent-facing metadata for dependency hints and fallbacks", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeExamples: true });
      const getCard = catalog.find((d) => d.action === "symbol.getCard");
      const needWindow = catalog.find((d) => d.action === "code.needWindow");

      assert.ok(getCard, "expected symbol.getCard descriptor");
      assert.ok(
        Array.isArray(getCard?.prerequisites),
        "symbol.getCard should expose prerequisites",
      );
      assert.ok(
        Array.isArray(getCard?.recommendedNextActions),
        "symbol.getCard should expose recommended next actions",
      );
      assert.ok(
        Array.isArray(getCard?.fallbacks),
        "symbol.getCard should expose fallbacks",
      );

      assert.ok(needWindow, "expected code.needWindow descriptor");
      assert.deepStrictEqual(needWindow?.prerequisites, [
        "code.getSkeleton",
        "code.getHotPath",
      ]);
      assert.ok(
        needWindow?.fallbacks.includes("code.getSkeleton"),
        "code.needWindow should suggest code.getSkeleton as a fallback",
      );
    });

    it("includeSchemas adds schemaSummary to descriptors", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeSchemas: true });
      const withSchema = catalog.filter((d) => d.schemaSummary !== undefined);
      assert.ok(withSchema.length > 0, "at least some descriptors should have schemas");
    });

    it("documents the corrected tool friction points in catalog metadata", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeSchemas: true });
      const byAction = new Map(catalog.map((descriptor) => [descriptor.action, descriptor]));

      const context = byAction.get("context");
      assert.ok(context?.schemaSummary, "context schema should be documented");
      const contextFieldNames = new Set(
        context.schemaSummary.fields.map((field) => field.name),
      );
      for (const expected of ["wireFormat", "responseMode", "ifNoneMatch"]) {
        assert.ok(contextFieldNames.has(expected), `context schema should include ${expected}`);
      }

      const contextBudget = context.schemaSummary.fields.find(
        (field) => field.name === "budget",
      );
      assert.ok(contextBudget, "context budget schema should be documented");
      const maxCards = contextBudget.subFields?.find(
        (field) => field.name === "maxCards",
      );
      assert.match(maxCards?.description ?? "", /unsupported/i);

      assert.match(byAction.get("action.search")?.description ?? "", /limit.*50/i);
      assert.match(byAction.get("index.refresh")?.description ?? "", /wait/i);
      assert.match(byAction.get("runtime.execute")?.description ?? "", /shell.*code/i);
      assert.match(byAction.get("search.edit")?.description ?? "", /dot/i);
      assert.match(byAction.get("buffer.checkpoint")?.description ?? "", /zero/i);
    });

    it("includeExamples adds example to descriptors", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeExamples: true });
      const withExample = catalog.filter((d) => d.example !== undefined);
      assert.ok(withExample.length > 0, "at least some descriptors should have examples");
    });

    it("without includes, no schemaSummary or example", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.strictEqual(desc.schemaSummary, undefined);
        assert.strictEqual(desc.example, undefined);
      }
    });
  });

  describe("rankCatalog", () => {
    it("ranks symbol.getCard high for 'symbol card' query", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "symbol card");
      assert.ok(ranked.length > 0, "should have results");
      const topActions = ranked.slice(0, 3).map((d) => d.action);
      assert.ok(
        topActions.includes("symbol.getCard") || topActions.includes(),
        `Expected symbol.getCard in top 3, got: ${topActions.join(", ")}`,
      );
    });

    it("returns empty array for no matches", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "xyznonexistent123");
      assert.strictEqual(ranked.length, 0);
    });

    it("matches by tag", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "transform");
      assert.ok(ranked.length >= 6, "should match all 6 transforms");
    });

    it("routes explain/debug/review prompts to context before workflow", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "debug review auth flow");
      assert.strictEqual(
        ranked[0]?.action,
        "context",
        `expected context first, got ${ranked.slice(0, 5).map((d) => d.action).join(", ")}`,
      );
    });

    it("routes execute/runtime/transform prompts to workflow before context", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "execute runtime pipeline transform");
      assert.strictEqual(
        ranked[0]?.action,
        "workflow",
        `expected workflow first, got ${ranked.slice(0, 5).map((d) => d.action).join(", ")}`,
      );
    });
  });

  describe("zodToSchemaSummary", () => {
    function field(summary: ReturnType<typeof zodToSchemaSummary>, name: string) {
      const result = summary.fields.find((candidate) => candidate.name === name);
      assert.ok(result, `expected schema field ${name}`);
      return result;
    }

    it("summarizes Zod v4 objects, defaults, and nested object fields", () => {
      const schema = z.object({
        name: z.string(),
        count: z.number().optional(),
        flag: z.boolean().default(false),
        nested: z.object({ mode: z.enum(["full", "incremental"]) }),
        clauses: z.array(z.object({ path: z.string(), negate: z.boolean().optional() })),
      });

      const summary = zodToSchemaSummary(schema);
      assert.strictEqual(summary.fields.length, 5);

      const nameField = field(summary, "name");
      assert.strictEqual(nameField.type, "string");
      assert.strictEqual(nameField.required, true);

      const countField = field(summary, "count");
      assert.strictEqual(countField.type, "number");
      assert.strictEqual(countField.required, false);

      const flagField = field(summary, "flag");
      assert.strictEqual(flagField.type, "boolean");
      assert.strictEqual(flagField.required, false);
      assert.strictEqual(flagField.default, false);

      const nestedField = field(summary, "nested");
      assert.strictEqual(nestedField.type, "object");
      assert.deepStrictEqual(
        nestedField.subFields?.map((subField) => subField.name),
        ["mode"],
      );
      assert.deepStrictEqual(nestedField.subFields?.[0]?.enumValues, [
        "full",
        "incremental",
      ]);

      const clausesField = field(summary, "clauses");
      assert.strictEqual(clausesField.type, "object[]");
      assert.deepStrictEqual(
        clausesField.subFields?.map((subField) => [subField.name, subField.required]),
        [
          ["path", true],
          ["negate", false],
        ],
      );
    });

    it("uses Zod v4 enum options for enum summaries", () => {
      const schema = z.object({
        mode: z.enum(["full", "incremental"]),
      });

      const summary = zodToSchemaSummary(schema);
      const modeField = field(summary, "mode");
      assert.strictEqual(modeField.type, "enum(full|incremental)");
      assert.deepStrictEqual(modeField.enumValues, ["full", "incremental"]);
      assert.strictEqual(modeField.required, true);
    });

    it("summarizes Zod v4 discriminated unions like search.edit", () => {
      const summary = zodToSchemaSummary(SearchEditRequestSchema);
      const names = summary.fields.map((summaryField) => summaryField.name);

      for (const expected of [
        "mode",
        "repoId",
        "targeting",
        "query",
        "editMode",
        "planHandle",
      ]) {
        assert.ok(names.includes(expected), `expected ${expected} in search.edit summary`);
      }

      const modeField = field(summary, "mode");
      assert.strictEqual(modeField.required, true);
      assert.strictEqual(modeField.type, "enum(preview|apply)");
      assert.deepStrictEqual(modeField.enumValues, ["preview", "apply"]);

      assert.strictEqual(field(summary, "repoId").required, true);
      assert.strictEqual(field(summary, "targeting").required, false);
      assert.strictEqual(field(summary, "query").required, false);
      assert.strictEqual(field(summary, "editMode").required, false);
      assert.strictEqual(field(summary, "planHandle").required, false);
    });

    it("handles non-object schema gracefully", () => {
      const summary = zodToSchemaSummary(z.string());
      assert.strictEqual(summary.fields.length, 0);
    });
  });
});
