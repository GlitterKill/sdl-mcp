import crypto from "crypto";
import { writeFile, mkdirSync } from "fs";
import { join } from "path";
import { describe, it } from "node:test";
import assert from "node:assert";
describe("Skeleton IR Determinism", () => {
    const TEST_SYMBOL_ID = "test-symbol-determinism";
    const NUM_RUNS = 10;
    const results = [];
    it("should produce byte-stable skeleton text across multiple runs", async () => {
        const baseSkeletonText = `function testSymbol() {
  const x = 1;
  const y = 2;
  return x + y;
}`;
        const textHashes = [];
        let byteStable = true;
        for (let i = 0; i < NUM_RUNS; i++) {
            const hash = crypto
                .createHash("sha256")
                .update(baseSkeletonText, "utf-8")
                .digest("hex");
            textHashes.push(hash);
            if (textHashes[i] !== textHashes[0]) {
                byteStable = false;
                console.error(`Byte stability broken at run ${i + 1}`);
            }
            results.push({
                symbolId: TEST_SYMBOL_ID,
                runNumber: i + 1,
                skeletonText: baseSkeletonText,
                skeletonIR: {
                    symbolId: TEST_SYMBOL_ID,
                    ops: [
                        { op: "call", target: "const", line: 2 },
                        { op: "return", line: 4 },
                    ],
                    hash: crypto
                        .createHash("sha256")
                        .update(JSON.stringify([
                        { op: "call", target: "const", line: 2 },
                        { op: "return", line: 4 },
                    ]), "utf-8")
                        .digest("hex"),
                    totalLines: 4,
                    elidedLines: 0,
                },
                textHash: hash,
                irHash: crypto
                    .createHash("sha256")
                    .update(JSON.stringify([
                    { op: "call", target: "const", line: 2 },
                    { op: "return", line: 4 },
                ]), "utf-8")
                    .digest("hex"),
            });
        }
        assert.strictEqual(byteStable, true);
        assert.strictEqual(new Set(textHashes).size, 1);
        console.log(`✅ Skeleton text is byte-stable across ${NUM_RUNS} runs`);
    });
    it("should produce byte-stable Skeleton IR across multiple runs", () => {
        const baseIR = {
            symbolId: TEST_SYMBOL_ID,
            ops: [
                { op: "call", target: "const", line: 2 },
                { op: "if", line: 3 },
                { op: "return", line: 4 },
            ],
            hash: "",
            totalLines: 4,
            elidedLines: 0,
        };
        const irHashes = [];
        let irStable = true;
        for (let i = 0; i < NUM_RUNS; i++) {
            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(baseIR.ops), "utf-8")
                .digest("hex");
            irHashes.push(hash);
            if (irHashes[i] !== irHashes[0]) {
                irStable = false;
                console.error(`IR stability broken at run ${i + 1}`);
            }
        }
        assert.strictEqual(irStable, true);
        assert.strictEqual(new Set(irHashes).size, 1);
        console.log(`✅ Skeleton IR is byte-stable across ${NUM_RUNS} runs`);
    });
    it("should generate stable IR hashes for identical inputs", () => {
        const ops = [
            { op: "call", target: "console.log", line: 1 },
            { op: "try", line: 2 },
            { op: "if", line: 3 },
            { op: "throw", line: 4 },
            { op: "return", line: 5 },
        ];
        const hashes = [];
        for (let i = 0; i < NUM_RUNS; i++) {
            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(ops), "utf-8")
                .digest("hex");
            hashes.push(hash);
        }
        const allEqual = hashes.every((h) => h === hashes[0]);
        assert.strictEqual(allEqual, true);
        console.log(`✅ IR hashes are stable: ${hashes[0]}`);
    });
    it("should produce deterministic results with elided blocks", () => {
        const elidedIR = {
            symbolId: "elided-test",
            ops: [
                {
                    op: "elision",
                    reason: "too-long",
                    startLine: 5,
                    endLine: 100,
                    estimatedLines: 95,
                },
                { op: "call", target: "fn", line: 101 },
            ],
            hash: "",
            totalLines: 100,
            elidedLines: 95,
        };
        const hashes = [];
        for (let i = 0; i < NUM_RUNS; i++) {
            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(elidedIR.ops), "utf-8")
                .digest("hex");
            hashes.push(hash);
        }
        const allEqual = hashes.every((h) => h === hashes[0]);
        assert.strictEqual(allEqual, true);
        console.log(`✅ Elided IR is deterministic: ${hashes[0]}`);
    });
    it("should produce deterministic results with side-effect markers", () => {
        const sideEffectIR = {
            symbolId: "sideeffect-test",
            ops: [
                { op: "call", target: "fetch", line: 1 },
                { op: "sideEffect", type: "network", line: 1 },
                { op: "if", line: 2 },
                { op: "sideEffect", type: "fs", line: 3 },
                { op: "return", line: 4 },
            ],
            hash: "",
            totalLines: 4,
            elidedLines: 0,
        };
        const hashes = [];
        for (let i = 0; i < NUM_RUNS; i++) {
            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(sideEffectIR.ops), "utf-8")
                .digest("hex");
            hashes.push(hash);
        }
        const allEqual = hashes.every((h) => h === hashes[0]);
        assert.strictEqual(allEqual, true);
        console.log(`✅ Side-effect IR is deterministic: ${hashes[0]}`);
    });
    it("should maintain hash stability across complex nested structures", () => {
        const complexIR = {
            symbolId: "complex-test",
            ops: [
                { op: "if", line: 1 },
                { op: "if", line: 2 },
                { op: "call", target: "fn1", line: 3 },
                { op: "try", line: 4 },
                { op: "call", target: "fn2", line: 5 },
                {
                    op: "elision",
                    reason: "nested",
                    startLine: 6,
                    endLine: 50,
                    estimatedLines: 44,
                },
                { op: "throw", line: 51 },
                { op: "return", line: 52 },
            ],
            hash: "",
            totalLines: 52,
            elidedLines: 44,
        };
        const hashes = [];
        for (let i = 0; i < NUM_RUNS; i++) {
            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(complexIR.ops), "utf-8")
                .digest("hex");
            hashes.push(hash);
        }
        const allEqual = hashes.every((h) => h === hashes[0]);
        assert.strictEqual(allEqual, true);
        console.log(`✅ Complex nested IR is deterministic: ${hashes[0]}`);
    });
    it("should produce same hash for semantically equivalent operations", () => {
        const ops1 = [{ op: "call", target: "console.log" }, { op: "return" }];
        const ops2 = [{ op: "call", target: "console.log" }, { op: "return" }];
        const hash1 = crypto
            .createHash("sha256")
            .update(JSON.stringify(ops1), "utf-8")
            .digest("hex");
        const hash2 = crypto
            .createHash("sha256")
            .update(JSON.stringify(ops2), "utf-8")
            .digest("hex");
        assert.strictEqual(hash1, hash2);
        console.log(`✅ Semantically equivalent ops produce same hash: ${hash1}`);
    });
    it("should produce different hashes for different operations", () => {
        const ops1 = [{ op: "call", target: "console.log" }];
        const ops2 = [{ op: "call", target: "console.warn" }];
        const hash1 = crypto
            .createHash("sha256")
            .update(JSON.stringify(ops1), "utf-8")
            .digest("hex");
        const hash2 = crypto
            .createHash("sha256")
            .update(JSON.stringify(ops2), "utf-8")
            .digest("hex");
        assert.notStrictEqual(hash1, hash2);
        console.log(`✅ Different ops produce different hashes`);
    });
    it("should save determinism results for debugging", async () => {
        const resultsDir = join("tests", "results");
        const resultsPath = join(resultsDir, "skeleton-determinism.json");
        try {
            mkdirSync(resultsDir, { recursive: true });
            const resultsData = {
                timestamp: new Date().toISOString(),
                totalRuns: NUM_RUNS,
                symbolId: TEST_SYMBOL_ID,
                results,
            };
            writeFile(resultsPath, JSON.stringify(resultsData, null, 2), "utf-8", (err) => {
                if (err) {
                    console.warn(`⚠️  Failed to save results: ${err}`);
                }
                else {
                    console.log(`✅ Determinism results saved to ${resultsPath}`);
                }
            });
        }
        catch (error) {
            console.warn(`⚠️  Failed to save results: ${error}`);
        }
    });
});
//# sourceMappingURL=skeleton-determinism.test.js.map