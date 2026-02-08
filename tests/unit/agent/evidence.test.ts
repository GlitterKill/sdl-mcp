import assert from "node:assert";
import { describe, it } from "node:test";
import { EvidenceCapture } from "../../../dist/agent/evidence.js";

describe("Evidence Capture", () => {
  describe("Symbol Card Evidence", () => {
    it("captures symbol card evidence", () => {
      const capture = new EvidenceCapture();
      const evidence = capture.captureSymbolCard(
        "symbol-1",
        "Function that does X",
      );

      assert.strictEqual(evidence.type, "symbolCard");
      assert.strictEqual(evidence.reference, "symbol:symbol-1");
      assert.strictEqual(evidence.summary, "Function that does X");
      assert.ok(evidence.timestamp > 0);
    });

    it("adds to evidence collection", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");
      capture.captureSymbolCard("symbol-2", "Summary 2");

      const evidence = capture.getEvidenceByType("symbolCard");
      assert.strictEqual(evidence.length, 2);
    });
  });

  describe("Skeleton Evidence", () => {
    it("captures skeleton evidence", () => {
      const capture = new EvidenceCapture();
      const evidence = capture.captureSkeleton(
        "file.ts",
        "10 lines, 3 functions",
      );

      assert.strictEqual(evidence.type, "skeleton");
      assert.strictEqual(evidence.reference, "file:file.ts");
      assert.strictEqual(evidence.summary, "10 lines, 3 functions");
    });
  });

  describe("Hot Path Evidence", () => {
    it("captures hot path evidence", () => {
      const capture = new EvidenceCapture();
      const evidence = capture.captureHotPath(
        "symbol-1",
        "5 lines in hot path",
      );

      assert.strictEqual(evidence.type, "hotPath");
      assert.strictEqual(evidence.reference, "hotpath:symbol-1");
      assert.strictEqual(evidence.summary, "5 lines in hot path");
    });
  });

  describe("Code Window Evidence", () => {
    it("captures code window evidence", () => {
      const capture = new EvidenceCapture();
      const evidence = capture.captureCodeWindow(
        "file.ts",
        100,
        "Code snippet",
      );

      assert.strictEqual(evidence.type, "codeWindow");
      assert.strictEqual(evidence.reference, "window:file.ts:100");
      assert.strictEqual(evidence.summary, "Code snippet");
    });
  });

  describe("Delta Evidence", () => {
    it("captures delta evidence", () => {
      const capture = new EvidenceCapture();
      const evidence = capture.captureDelta("v1.0", "v2.0", "Added 5 symbols");

      assert.strictEqual(evidence.type, "delta");
      assert.strictEqual(evidence.reference, "delta:v1.0:v2.0");
      assert.strictEqual(evidence.summary, "Added 5 symbols");
    });
  });

  describe("Diagnostic Evidence", () => {
    it("captures diagnostic evidence", () => {
      const capture = new EvidenceCapture();
      const evidence = capture.captureDiagnostic("file.ts", 10, "Type error");

      assert.strictEqual(evidence.type, "diagnostic");
      assert.strictEqual(evidence.reference, "diagnostic:file.ts:10");
      assert.strictEqual(evidence.summary, "Type error");
    });
  });

  describe("Search Result Evidence", () => {
    it("captures search result evidence", () => {
      const capture = new EvidenceCapture();
      const evidence = capture.captureSearchResult("function", 15);

      assert.strictEqual(evidence.type, "searchResult");
      assert.strictEqual(evidence.reference, "search:function");
      assert.strictEqual(evidence.summary, "Found 15 results");
    });
  });

  describe("Evidence Retrieval", () => {
    it("returns all evidence in chronological order", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");
      capture.captureSkeleton("file.ts", "10 lines");
      capture.captureHotPath("symbol-2", "5 lines");

      const allEvidence = capture.getAllEvidence();
      assert.strictEqual(allEvidence.length, 3);
      assert.strictEqual(allEvidence[0].type, "symbolCard");
      assert.strictEqual(allEvidence[1].type, "skeleton");
      assert.strictEqual(allEvidence[2].type, "hotPath");
    });

    it("returns evidence by type", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");
      capture.captureSymbolCard("symbol-2", "Summary 2");
      capture.captureSkeleton("file.ts", "10 lines");

      const symbolCards = capture.getEvidenceByType("symbolCard");
      assert.strictEqual(symbolCards.length, 2);
      assert.strictEqual(symbolCards[0].type, "symbolCard");
    });

    it("returns empty array for unknown type", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");

      const unknown = capture.getEvidenceByType("unknown" as any);
      assert.deepStrictEqual(unknown, []);
    });

    it("counts total evidence", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");
      capture.captureSkeleton("file.ts", "10 lines");
      capture.captureHotPath("symbol-2", "5 lines");

      assert.strictEqual(capture.getEvidenceCount(), 3);
    });

    it("counts evidence by type", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");
      capture.captureSymbolCard("symbol-2", "Summary 2");
      capture.captureSkeleton("file.ts", "10 lines");

      assert.strictEqual(capture.getEvidenceCount("symbolCard"), 2);
      assert.strictEqual(capture.getEvidenceCount("skeleton"), 1);
    });
  });

  describe("Evidence Summary", () => {
    it("generates evidence summary", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");
      capture.captureSymbolCard("symbol-2", "Summary 2");
      capture.captureSkeleton("file.ts", "10 lines");

      const summary = capture.getEvidenceSummary();
      assert.strictEqual(summary.symbolCard, 2);
      assert.strictEqual(summary.skeleton, 1);
    });
  });

  describe("Evidence Reset", () => {
    it("resets evidence collection", () => {
      const capture = new EvidenceCapture();
      capture.captureSymbolCard("symbol-1", "Summary 1");
      capture.captureSkeleton("file.ts", "10 lines");

      assert.strictEqual(capture.getEvidenceCount(), 2);

      capture.reset();

      assert.strictEqual(capture.getEvidenceCount(), 0);
      assert.deepStrictEqual(capture.getAllEvidence(), []);
    });
  });

  describe("Evidence Timestamps", () => {
    it("assigns unique timestamps", () => {
      const capture = new EvidenceCapture();
      const now = Date.now();

      const evidence1 = capture.captureSymbolCard("symbol-1", "Summary 1");
      const evidence2 = capture.captureSymbolCard("symbol-2", "Summary 2");

      assert.ok(evidence1.timestamp >= now);
      assert.ok(evidence2.timestamp >= now);
      assert.ok(evidence2.timestamp >= evidence1.timestamp);
    });
  });
});
