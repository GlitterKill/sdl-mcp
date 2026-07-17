import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import {
  clearSnapshotCache,
  getOverlaySnapshot,
} from "../../dist/live-index/overlay-reader.js";
import {
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../dist/live-index/coordinator.js";
import { handleAgentContext } from "../../dist/mcp/tools/context.js";
import { handleBufferPush } from "../../dist/mcp/tools/buffer.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";

const REPO_ID = "context-overlay-evidence-invariant";
const REL_PATH = "src/evidence.ts";

type BatchResolution = {
  snapshot: unknown;
  items: Array<
    | {
        status: "resolved";
        symbolId: string;
        source: "durable" | "overlay";
        symbol: ladybugDb.SymbolRow;
        file?: ladybugDb.FileRow;
      }
    | {
        status: "missing";
        symbolId: string;
        reason: "not_found" | "shadowed" | "repo_mismatch";
      }
  >;
};

type BatchResolver = (
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  repoId: string,
  symbolIds: string[],
) => Promise<BatchResolution>;

function findSymbol(
  symbols: ladybugDb.SymbolRow[],
  name: string,
): ladybugDb.SymbolRow {
  const symbol = symbols.find((row) => row.name === name);
  assert.ok(symbol, `Expected symbol ${name}`);
  return symbol;
}

function signatureValue(symbol: ladybugDb.SymbolRow): Record<string, unknown> {
  assert.ok(symbol.signatureJson, `Expected signature for ${symbol.name}`);
  return JSON.parse(symbol.signatureJson) as Record<string, unknown>;
}

describe("context overlay evidence invariant", () => {
  const graphDbPath = join(
    tmpdir(),
    `.lbug-context-overlay-evidence-${process.pid}.lbug`,
  );
  const configPath = join(
    tmpdir(),
    `sdl-context-overlay-evidence-${process.pid}.json`,
  );
  const previousSDLConfig = process.env.SDL_CONFIG;
  const previousSDLConfigPath = process.env.SDL_CONFIG_PATH;
  let repoDir = "";
  let durableRemoved: ladybugDb.SymbolRow;
  let durableModified: ladybugDb.SymbolRow;

  before(async () => {
    rmSync(graphDbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-context-overlay-evidence-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, REL_PATH),
      [
        "export function removed(value: string): string {",
        "  return value.toUpperCase();",
        "}",
        "",
        "export function modified(value: string): string {",
        "  return value.trim();",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [],
        policy: {},
        indexing: { engine: "typescript", enableFileWatching: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: "2026-07-17T00:00:00.000Z",
    });
    await indexRepo(REPO_ID, "full");

    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);
    durableRemoved = findSymbol(symbols, "removed");
    durableModified = findSymbol(symbols, "modified");
  });

  after(async () => {
    resetDefaultLiveIndexCoordinator();
    clearSnapshotCache();
    await closeLadybugDb();
    rmSync(graphDbPath, { recursive: true, force: true });
    rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }
    if (previousSDLConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousSDLConfig;
    if (previousSDLConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousSDLConfigPath;
  });

  it("keeps context evidence and same-session cards on one overlay-aware symbol view", async () => {
    const overlayReader =
      (await import("../../dist/live-index/overlay-reader.js")) as unknown as {
        resolveSymbolsWithOverlay?: BatchResolver;
      };
    assert.equal(
      typeof overlayReader.resolveSymbolsWithOverlay,
      "function",
      "overlay-reader must expose the shared batch symbol resolver",
    );
    const resolveSymbolsWithOverlay = overlayReader.resolveSymbolsWithOverlay!;
    const conn = await getLadybugConn();

    const durableOnly = await resolveSymbolsWithOverlay(conn, REPO_ID, [
      durableModified.symbolId,
      durableRemoved.symbolId,
      durableModified.symbolId,
    ]);
    assert.deepEqual(
      durableOnly.items.map((item) => [
        item.symbolId,
        item.status,
        "source" in item ? item.source : null,
      ]),
      [
        [durableModified.symbolId, "resolved", "durable"],
        [durableRemoved.symbolId, "resolved", "durable"],
        [durableModified.symbolId, "resolved", "durable"],
      ],
    );

    await handleBufferPush({
      repoId: REPO_ID,
      eventType: "change",
      filePath: REL_PATH,
      content: [
        "",
        "",
        "",
        "",
        "export function modified(value: number): number {",
        "  return value * 2;",
        "}",
        "",
        "export function added(flag: boolean): boolean {",
        "  return !flag;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
      dirty: true,
      timestamp: "2026-07-17T00:01:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();
    clearSnapshotCache();

    const snapshot = getOverlaySnapshot(REPO_ID);
    const overlayModified = snapshot.symbolsById.get(durableModified.symbolId);
    assert.ok(overlayModified, "Modified symbol must retain its durable ID");
    const overlayAdded = [...snapshot.symbolsById.values()].find(
      (symbol) => symbol.name === "added",
    );
    assert.ok(overlayAdded, "Expected overlay-only added symbol");

    const ids = [
      durableRemoved.symbolId,
      durableModified.symbolId,
      overlayAdded.symbolId,
      durableModified.symbolId,
    ];
    const resolved = await resolveSymbolsWithOverlay(conn, REPO_ID, ids);
    assert.deepEqual(
      resolved.items.map((item) => [
        item.symbolId,
        item.status,
        "source" in item ? item.source : item.reason,
      ]),
      [
        [durableRemoved.symbolId, "missing", "shadowed"],
        [durableModified.symbolId, "resolved", "overlay"],
        [overlayAdded.symbolId, "resolved", "overlay"],
        [durableModified.symbolId, "resolved", "overlay"],
      ],
    );

    const session = { sessionId: `context-overlay-${process.pid}` };
    const context = await handleAgentContext(
      {
        repoId: REPO_ID,
        taskType: "explain",
        taskText: "Explain the modified and added functions",
        budget: { maxActions: 3, maxTokens: 10_000 },
        options: {
          contextMode: "broad",
          semantic: false,
          focusSymbols: [
            durableRemoved.symbolId,
            durableModified.symbolId,
            overlayAdded.symbolId,
          ],
          cardDetail: "full",
        },
        responseMode: "inline",
        wireFormat: "json",
        refsMode: "off",
      },
      session,
    );
    assert.ok("finalEvidence" in context);
    const symbolEvidence = context.finalEvidence.filter((evidence) =>
      evidence.reference.startsWith("symbol:"),
    );
    const evidenceIds = symbolEvidence.map((evidence) =>
      evidence.reference.slice("symbol:".length),
    );
    assert.ok(!evidenceIds.includes(durableRemoved.symbolId));
    assert.ok(evidenceIds.includes(durableModified.symbolId));
    assert.ok(evidenceIds.includes(overlayAdded.symbolId));
    for (const evidence of context.finalEvidence) {
      assert.ok(
        !evidence.reference.endsWith(durableRemoved.symbolId),
        `Removed durable symbol leaked through ${evidence.type} evidence`,
      );
    }

    const expectedById = new Map([
      [durableModified.symbolId, overlayModified],
      [overlayAdded.symbolId, overlayAdded],
    ]);
    for (const evidence of symbolEvidence) {
      const symbolId = evidence.reference.slice("symbol:".length);
      const expected = expectedById.get(symbolId);
      assert.ok(expected, `Unexpected context evidence ${symbolId}`);
      const expectedFile = snapshot.filesById.get(expected.fileId);
      assert.ok(expectedFile);
      const expectedSignature = signatureValue(expected);
      assert.match(evidence.summary, new RegExp(expectedFile.relPath));
      if (typeof expectedSignature.text === "string") {
        assert.ok(evidence.summary.includes(`sig: ${expectedSignature.text}`));
      }

      const cardResponse = await handleSymbolGetCard(
        { repoId: REPO_ID, symbolId, refsMode: "off" },
        session,
      );
      assert.ok("card" in cardResponse);
      assert.equal(cardResponse.card.file, expectedFile.relPath);
      assert.deepEqual(cardResponse.card.range, {
        startLine: expected.rangeStartLine,
        startCol: expected.rangeStartCol,
        endLine: expected.rangeEndLine,
        endCol: expected.rangeEndCol,
      });
      assert.deepEqual(cardResponse.card.signature, expectedSignature);
    }

    const batch = await handleSymbolGetCard(
      {
        repoId: REPO_ID,
        symbolIds: [
          durableRemoved.symbolId,
          durableModified.symbolId,
          overlayAdded.symbolId,
        ],
        refsMode: "off",
      },
      session,
    );
    assert.deepEqual(batch.succeeded, [
      durableModified.symbolId,
      overlayAdded.symbolId,
    ]);
    assert.deepEqual(batch.failed, [durableRemoved.symbolId]);
    assert.deepEqual(
      batch.cards.map((card) => ("symbolId" in card ? card.symbolId : null)),
      [durableModified.symbolId, overlayAdded.symbolId],
    );
    await assert.rejects(
      () =>
        handleSymbolGetCard(
          {
            repoId: REPO_ID,
            symbolId: durableRemoved.symbolId,
            refsMode: "off",
          },
          session,
        ),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  });
});
