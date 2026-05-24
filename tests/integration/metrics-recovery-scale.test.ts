import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { recoverMissingMetricsForRepo } from "../../dist/graph/metrics-recovery.js";

const BENCH_ENABLED = process.env.SDL_METRICS_REPAIR_BENCH === "1";
const REPO_ID = "metrics-recovery-scale-repo";
const SYMBOL_COUNT = 50_000;
const FIRST_PASS_LIMIT = 25_000;

describe(
  "metrics recovery scale benchmark",
  { skip: !BENCH_ENABLED },
  () => {
    let graphDbPath = "";

    before(async () => {
      graphDbPath = mkdtempSync(join(tmpdir(), "sdl-metrics-recovery-scale-"));
      await closeLadybugDb();
      await initLadybugDb(graphDbPath);
      const now = "2024-01-01T00:00:00.000Z";
      await withWriteConn(async (wConn) => {
        await ladybugDb.upsertRepo(wConn, {
          repoId: REPO_ID,
          rootPath: graphDbPath,
          configJson: "{}",
          createdAt: now,
        });
        await ladybugDb.upsertFileBatch(wConn, [
          {
            fileId: `${REPO_ID}:src/large.ts`,
            repoId: REPO_ID,
            relPath: "src/large.ts",
            contentHash: "hash",
            language: "typescript",
            byteSize: SYMBOL_COUNT,
            lastIndexedAt: now,
          },
        ]);
        await ladybugDb.upsertSymbolBatch(
          wConn,
          Array.from({ length: SYMBOL_COUNT }, (_, index) => ({
            symbolId: `sym-${String(index).padStart(5, "0")}`,
            repoId: REPO_ID,
            fileId: `${REPO_ID}:src/large.ts`,
            kind: "function",
            name: `sym${index}`,
            exported: true,
            visibility: "public",
            language: "typescript",
            rangeStartLine: index + 1,
            rangeStartCol: 0,
            rangeEndLine: index + 1,
            rangeEndCol: 10,
            astFingerprint: `fp-${index}`,
            signatureJson: "{}",
            summary: null,
            invariantsJson: null,
            sideEffectsJson: null,
            updatedAt: now,
          })),
        );
        await ladybugDb.insertEdges(
          wConn,
          Array.from({ length: SYMBOL_COUNT }, (_, index) => {
            const next = (index + 1) % SYMBOL_COUNT;
            return {
              repoId: REPO_ID,
              fromSymbolId: `sym-${String(index).padStart(5, "0")}`,
              toSymbolId: `sym-${String(next).padStart(5, "0")}`,
              edgeType: "call",
              weight: 1,
              confidence: 1,
              resolution: "exact",
              provenance: null,
              createdAt: now,
            };
          }),
        );
      });
    });

    after(async () => {
      await closeLadybugDb();
      if (graphDbPath && existsSync(graphDbPath)) {
        rmSync(graphDbPath, { recursive: true, force: true });
      }
    });

    it("repairs missing metrics with visible progress and resumes partial rows", async () => {
      const first = await recoverMissingMetricsForRepo(REPO_ID, {
        limit: FIRST_PASS_LIMIT,
      });
      assert.equal(first.repairedRows, FIRST_PASS_LIMIT);
      assert.equal(first.writeMode, "copy");

      const progressMessages: string[] = [];
      const second = await recoverMissingMetricsForRepo(REPO_ID, {
        onProgress: (progress) => {
          if (progress.message) progressMessages.push(progress.message);
        },
      });

      assert.equal(second.missingRows, SYMBOL_COUNT - FIRST_PASS_LIMIT);
      assert.equal(second.repairedRows, SYMBOL_COUNT - FIRST_PASS_LIMIT);
      assert.equal(second.writeMode, "copy");
      assert.ok(
        progressMessages.some((message) => message.includes("Aggregating fan counts")),
      );
      assert.ok(
        progressMessages.some((message) => message.includes("Recovered")),
      );
    });
  },
);
