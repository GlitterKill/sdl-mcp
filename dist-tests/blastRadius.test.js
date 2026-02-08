import { describe, it } from "node:test";
import assert from "node:assert";
import { computeBlastRadius } from "../dist/delta/blastRadius.js";
describe("BlastRadius Edge Cases", () => {
    describe("maxHops validation", () => {
        it("should handle maxHops=0 gracefully (AC1)", () => {
            const changedSymbols = ["symbol-1"];
            const graph = {
                repoId: "test-repo",
                symbols: new Map([
                    [
                        "symbol-1",
                        {
                            symbol_id: "symbol-1",
                            repo_id: "test-repo",
                            file_id: 1,
                            kind: "function",
                            name: "testFunction",
                            exported: 1,
                            visibility: "public",
                            language: "typescript",
                            range_start_line: 1,
                            range_start_col: 0,
                            range_end_line: 5,
                            range_end_col: 1,
                            ast_fingerprint: "abc123",
                            signature_json: null,
                            summary: "A test function",
                            invariants_json: null,
                            side_effects_json: null,
                            updated_at: new Date().toISOString(),
                        },
                    ],
                ]),
                edges: [],
                adjacencyIn: new Map([["symbol-1", []]]),
                adjacencyOut: new Map([["symbol-1", []]]),
            };
            const result = computeBlastRadius(changedSymbols, graph, { maxHops: 0 });
            assert.strictEqual(result.length, 0, "Should return empty array for maxHops=0");
        });
        it("should handle negative maxHops gracefully", () => {
            const changedSymbols = ["symbol-1"];
            const graph = {
                repoId: "test-repo",
                symbols: new Map([
                    [
                        "symbol-1",
                        {
                            symbol_id: "symbol-1",
                            repo_id: "test-repo",
                            file_id: 1,
                            kind: "function",
                            name: "testFunction",
                            exported: 1,
                            visibility: "public",
                            language: "typescript",
                            range_start_line: 1,
                            range_start_col: 0,
                            range_end_line: 5,
                            range_end_col: 1,
                            ast_fingerprint: "abc123",
                            signature_json: null,
                            summary: "A test function",
                            invariants_json: null,
                            side_effects_json: null,
                            updated_at: new Date().toISOString(),
                        },
                    ],
                ]),
                edges: [],
                adjacencyIn: new Map([["symbol-1", []]]),
                adjacencyOut: new Map([["symbol-1", []]]),
            };
            const result = computeBlastRadius(changedSymbols, graph, { maxHops: -1 });
            assert.strictEqual(result.length, 0, "Should return empty array for negative maxHops");
        });
    });
    describe("edge case combinations", () => {
        it("should handle empty changed symbols list", () => {
            const changedSymbols = [];
            const graph = {
                repoId: "test-repo",
                symbols: new Map(),
                edges: [],
                adjacencyIn: new Map(),
                adjacencyOut: new Map(),
            };
            const result = computeBlastRadius(changedSymbols, graph);
            assert.strictEqual(result.length, 0, "Should return empty array for no changed symbols");
        });
        it("should handle graph with no edges", () => {
            const changedSymbols = ["symbol-1"];
            const graph = {
                repoId: "test-repo",
                symbols: new Map([
                    [
                        "symbol-1",
                        {
                            symbol_id: "symbol-1",
                            repo_id: "test-repo",
                            file_id: 1,
                            kind: "function",
                            name: "isolatedFunction",
                            exported: 1,
                            visibility: "public",
                            language: "typescript",
                            range_start_line: 1,
                            range_start_col: 0,
                            range_end_line: 5,
                            range_end_col: 1,
                            ast_fingerprint: "abc123",
                            signature_json: null,
                            summary: "An isolated function",
                            invariants_json: null,
                            side_effects_json: null,
                            updated_at: new Date().toISOString(),
                        },
                    ],
                ]),
                edges: [],
                adjacencyIn: new Map([["symbol-1", []]]),
                adjacencyOut: new Map([["symbol-1", []]]),
            };
            const result = computeBlastRadius(changedSymbols, graph);
            assert.strictEqual(result.length, 0, "Should return empty array for isolated symbol");
        });
    });
    describe("missing symbol handling", () => {
        it("should handle missing symbol in graph gracefully (AC2)", () => {
            const changedSymbols = ["symbol-missing"];
            const graph = {
                repoId: "test-repo",
                symbols: new Map(),
                edges: [],
                adjacencyIn: new Map([["symbol-missing", []]]),
                adjacencyOut: new Map([["symbol-missing", []]]),
            };
            const result = computeBlastRadius(changedSymbols, graph, { maxHops: 2 });
            assert.ok(Array.isArray(result), "Should return an array");
            assert.ok(result.length >= 0, "Should handle missing symbol without error");
        });
        it("should handle mix of present and missing symbols", () => {
            const changedSymbols = ["symbol-1", "symbol-missing"];
            const graph = {
                repoId: "test-repo",
                symbols: new Map([
                    [
                        "symbol-1",
                        {
                            symbol_id: "symbol-1",
                            repo_id: "test-repo",
                            file_id: 1,
                            kind: "function",
                            name: "testFunction",
                            exported: 1,
                            visibility: "public",
                            language: "typescript",
                            range_start_line: 1,
                            range_start_col: 0,
                            range_end_line: 5,
                            range_end_col: 1,
                            ast_fingerprint: "abc123",
                            signature_json: null,
                            summary: "A test function",
                            invariants_json: null,
                            side_effects_json: null,
                            updated_at: new Date().toISOString(),
                        },
                    ],
                ]),
                edges: [],
                adjacencyIn: new Map([
                    ["symbol-1", []],
                    ["symbol-missing", []],
                ]),
                adjacencyOut: new Map([
                    ["symbol-1", []],
                    ["symbol-missing", []],
                ]),
            };
            const result = computeBlastRadius(changedSymbols, graph, { maxHops: 2 });
            assert.ok(Array.isArray(result), "Should return an array");
            assert.ok(result.length >= 0, "Should handle mix of present and missing symbols");
        });
    });
});
//# sourceMappingURL=blastRadius.test.js.map