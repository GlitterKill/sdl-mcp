/**
 * Tests for enhanced heuristic summaries: class, interface, type, variable,
 * constructor generators, quality scoring, and source classification.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateSummary,
  getSummaryQuality,
  classifySummarySource,
} from "../../dist/indexer/summaries.js";

/**
 * Minimal ExtractedSymbol-compatible fixture builder.
 * Mirrors the pattern in tests/generate-summary.test.ts.
 */
const makeSymbol = (overrides: Record<string, unknown>) => ({
  name: "testSymbol",
  kind: "function",
  range: { startLine: 10, startCol: 0, endLine: 20, endCol: 1 },
  exported: true,
  signature: null,
  ...overrides,
});

describe("enhanced heuristic summaries", () => {
  // ── Class summaries ──────────────────────────────────────────────────

  describe("class summaries", () => {
    it("generates role-based summary for Provider suffix", () => {
      const symbol = makeSymbol({ name: "AuthProvider", kind: "class" });
      const result = generateSummary(symbol as any, "class AuthProvider {}");
      assert.strictEqual(result, "Implements the provider pattern for auth");
    });

    it("generates role-based summary for Factory suffix", () => {
      const symbol = makeSymbol({ name: "WidgetFactory", kind: "class" });
      const result = generateSummary(symbol as any, "class WidgetFactory {}");
      assert.strictEqual(result, "Implements the factory pattern for widget");
    });

    it("generates role-based summary for Handler suffix", () => {
      const symbol = makeSymbol({ name: "ErrorHandler", kind: "class" });
      const result = generateSummary(symbol as any, "class ErrorHandler {}");
      assert.strictEqual(result, "Implements the handler pattern for error");
    });

    it("generates generic class summary", () => {
      const symbol = makeSymbol({
        name: "Repository",
        kind: "class",
        signature: { generics: ["T", "K"] },
      });
      const result = generateSummary(symbol as any, "class Repository<T, K> {}");
      assert.strictEqual(result, "Generic repository class parameterized by T, K");
    });

    it("generates fallback class summary", () => {
      const symbol = makeSymbol({ name: "UserAccount", kind: "class" });
      const result = generateSummary(symbol as any, "class UserAccount {}");
      assert.strictEqual(result, "Class encapsulating user account behavior");
    });

    it("generates fallback class summary for single-word name", () => {
      const symbol = makeSymbol({ name: "Config", kind: "class" });
      const result = generateSummary(symbol as any, "class Config {}");
      assert.strictEqual(result, "Class encapsulating config behavior");
    });
  });

  // ── Interface summaries ──────────────────────────────────────────────

  describe("interface summaries", () => {
    it("generates I-prefix contract summary", () => {
      const symbol = makeSymbol({ name: "IUserService", kind: "interface" });
      const result = generateSummary(symbol as any, "interface IUserService {}");
      assert.strictEqual(result, "Contract for user service");
    });

    it("generates Props suffix summary", () => {
      const symbol = makeSymbol({ name: "ButtonProps", kind: "interface" });
      const result = generateSummary(symbol as any, "interface ButtonProps {}");
      assert.strictEqual(result, "Props definition for button");
    });

    it("generates Options suffix summary", () => {
      const symbol = makeSymbol({ name: "SearchOptions", kind: "interface" });
      const result = generateSummary(symbol as any, "interface SearchOptions {}");
      assert.strictEqual(result, "Options definition for search");
    });

    it("generates generic interface summary", () => {
      const symbol = makeSymbol({
        name: "Comparable",
        kind: "interface",
        signature: { generics: ["T"] },
      });
      const result = generateSummary(symbol as any, "interface Comparable<T> {}");
      assert.strictEqual(result, "Generic interface defining comparable contract for T");
    });

    it("generates fallback interface summary", () => {
      const symbol = makeSymbol({ name: "SymbolCard", kind: "interface" });
      const result = generateSummary(symbol as any, "interface SymbolCard {}");
      assert.strictEqual(result, "Interface defining symbol card contract");
    });
  });

  // ── Type summaries ───────────────────────────────────────────────────

  describe("type summaries", () => {
    it("generates Result suffix summary", () => {
      const symbol = makeSymbol({ name: "QueryResult", kind: "type" });
      const result = generateSummary(symbol as any, "type QueryResult = {};");
      assert.strictEqual(result, "Result type for query");
    });

    it("generates Response suffix summary", () => {
      const symbol = makeSymbol({ name: "ApiResponse", kind: "type" });
      const result = generateSummary(symbol as any, "type ApiResponse = {};");
      assert.strictEqual(result, "Response type for api");
    });

    it("generates generic type summary", () => {
      const symbol = makeSymbol({
        name: "Mapper",
        kind: "type",
        signature: { generics: ["TIn", "TOut"] },
      });
      const result = generateSummary(symbol as any, "type Mapper<TIn, TOut> = {};");
      assert.strictEqual(result, "Generic type alias for mapper over TIn, TOut");
    });

    it("generates fallback type alias summary", () => {
      const symbol = makeSymbol({ name: "UserId", kind: "type" });
      const result = generateSummary(symbol as any, "type UserId = string;");
      assert.strictEqual(result, "Type alias for user id");
    });
  });

  // ── Variable summaries ───────────────────────────────────────────────

  describe("variable summaries", () => {
    it("generates SCREAMING_SNAKE constant summary", () => {
      const symbol = makeSymbol({ name: "MAX_RETRIES", kind: "variable" });
      const result = generateSummary(symbol as any, "const MAX_RETRIES = 3;");
      assert.strictEqual(result, "Constant defining max retries");
    });

    it("generates Schema suffix summary", () => {
      const symbol = makeSymbol({ name: "userSchema", kind: "variable" });
      const result = generateSummary(symbol as any, "const userSchema = z.object({});");
      assert.strictEqual(result, "Validation schema for user");
    });

    it("generates Validator suffix summary", () => {
      const symbol = makeSymbol({ name: "emailValidator", kind: "variable" });
      const result = generateSummary(symbol as any, "const emailValidator = {};");
      assert.strictEqual(result, "Validator for email");
    });

    it("generates default prefix summary", () => {
      const symbol = makeSymbol({ name: "defaultTimeout", kind: "variable" });
      const result = generateSummary(symbol as any, "const defaultTimeout = 5000;");
      assert.strictEqual(result, "Default timeout value");
    });

    it("returns null for plain variables", () => {
      const symbol = makeSymbol({ name: "count", kind: "variable" });
      const result = generateSummary(symbol as any, "const count = 0;");
      assert.strictEqual(result, null);
    });
  });

  // ── Constructor summaries ────────────────────────────────────────────

  describe("constructor summaries", () => {
    it("generates constructor summary with typed params", () => {
      const symbol = makeSymbol({
        name: "constructor",
        kind: "constructor",
        signature: {
          params: [
            { name: "name", type: ": string" },
            { name: "age", type: ": number" },
          ],
        },
      });
      const result = generateSummary(symbol as any, "constructor(name: string, age: number) {}");
      assert.strictEqual(result, "Constructs from string and number");
    });

    it("returns null for constructor with no params", () => {
      const symbol = makeSymbol({
        name: "constructor",
        kind: "constructor",
        signature: { params: [] },
      });
      const result = generateSummary(symbol as any, "constructor() {}");
      assert.strictEqual(result, null);
    });

    it("returns null for constructor with untyped params", () => {
      const symbol = makeSymbol({
        name: "constructor",
        kind: "constructor",
        signature: {
          params: [{ name: "x" }, { name: "y" }],
        },
      });
      const result = generateSummary(symbol as any, "constructor(x, y) {}");
      assert.strictEqual(result, null);
    });
  });

  // ── Quality scoring ──────────────────────────────────────────────────

  describe("quality scoring", () => {
    it("returns 1.0 for jsdoc source", () => {
      assert.strictEqual(getSummaryQuality("test", "jsdoc"), 1.0);
    });

    it("returns 0.8 for llm source", () => {
      assert.strictEqual(getSummaryQuality("test", "llm"), 0.8);
    });

    it("returns 0.6 for nn-direct source", () => {
      assert.strictEqual(getSummaryQuality("test", "nn-direct"), 0.6);
    });

    it("returns 0.5 for nn-adapted source", () => {
      assert.strictEqual(getSummaryQuality("test", "nn-adapted"), 0.5);
    });

    it("returns 0.4 for heuristic-typed source", () => {
      assert.strictEqual(getSummaryQuality("test", "heuristic-typed"), 0.4);
    });

    it("returns 0.3 for heuristic-fallback source", () => {
      assert.strictEqual(getSummaryQuality("test", "heuristic-fallback"), 0.3);
    });

    it("returns 0.0 for null summary", () => {
      assert.strictEqual(getSummaryQuality(null, "unknown"), 0.0);
    });

    it("returns 0.0 for unknown source with non-null summary", () => {
      assert.strictEqual(getSummaryQuality("test", "unknown"), 0.0);
    });
  });

  // ── Source classification ────────────────────────────────────────────

  describe("source classification", () => {
    it("classifies JSDoc source", () => {
      assert.strictEqual(classifySummarySource("test summary", true, "class"), "jsdoc");
    });

    it("classifies heuristic-typed for functions", () => {
      assert.strictEqual(classifySummarySource("test summary", false, "function"), "heuristic-typed");
    });

    it("classifies heuristic-typed for methods", () => {
      assert.strictEqual(classifySummarySource("test summary", false, "method"), "heuristic-typed");
    });

    it("classifies heuristic-typed for constructors", () => {
      assert.strictEqual(classifySummarySource("test summary", false, "constructor"), "heuristic-typed");
    });

    it("classifies heuristic-fallback for classes", () => {
      assert.strictEqual(classifySummarySource("test summary", false, "class"), "heuristic-fallback");
    });

    it("classifies heuristic-fallback for interfaces", () => {
      assert.strictEqual(classifySummarySource("test summary", false, "interface"), "heuristic-fallback");
    });

    it("classifies heuristic-fallback for types", () => {
      assert.strictEqual(classifySummarySource("test summary", false, "type"), "heuristic-fallback");
    });

    it("classifies unknown for null summary", () => {
      assert.strictEqual(classifySummarySource(null, false, "function"), "unknown");
    });

    it("classifies unknown for null summary even with JSDoc", () => {
      assert.strictEqual(classifySummarySource(null, true, "function"), "unknown");
    });
  });

  // ── JSDoc priority ───────────────────────────────────────────────────

  describe("JSDoc always takes priority", () => {
    it("uses JSDoc over class heuristic", () => {
      const symbol = makeSymbol({
        name: "AuthProvider",
        kind: "class",
        range: { startLine: 2, startCol: 0, endLine: 4, endCol: 1 },
      });
      const content = "/** Handles OAuth2 authentication flows. */\nclass AuthProvider {}";
      const result = generateSummary(symbol as any, content);
      assert.ok(result !== null, "should not be null");
      assert.match(result!, /OAuth2|authentication/i);
    });

    it("uses JSDoc over interface heuristic", () => {
      const symbol = makeSymbol({
        name: "IUserService",
        kind: "interface",
        range: { startLine: 2, startCol: 0, endLine: 4, endCol: 1 },
      });
      const content = "/** Defines the user management API surface. */\ninterface IUserService {}";
      const result = generateSummary(symbol as any, content);
      assert.ok(result !== null, "should not be null");
      assert.match(result!, /user management/i);
    });

    it("uses JSDoc over variable constant heuristic", () => {
      const symbol = makeSymbol({
        name: "MAX_RETRIES",
        kind: "variable",
        range: { startLine: 2, startCol: 0, endLine: 2, endCol: 30 },
      });
      const content = "/** Maximum number of retry attempts before giving up. */\nconst MAX_RETRIES = 3;";
      const result = generateSummary(symbol as any, content);
      assert.ok(result !== null, "should not be null");
      assert.match(result!, /retry|attempts/i);
    });
  });
});
