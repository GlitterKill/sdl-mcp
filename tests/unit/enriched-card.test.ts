import { describe, it } from "node:test";
import assert from "node:assert";

import { SYMBOL_CARD_MAX_PROCESSES } from "../../dist/config/constants.js";
import { toCardAtDetailLevel, estimateTokens } from "../../dist/graph/slice/slice-serializer.js";
import { hashCard } from "../../dist/util/hashing.js";

describe("enriched symbol cards (cluster/process)", () => {
  const baseCard = {
    symbolId: "sym-1",
    repoId: "repo-1",
    file: "src/app.ts",
    range: { startLine: 1, startCol: 0, endLine: 10, endCol: 1 },
    kind: "function",
    name: "main",
    exported: true,
    deps: { imports: ["imp-1"], calls: ["call-1", "call-2"] },
    cluster: { clusterId: "cluster-1", label: "Cluster 1", memberCount: 10 },
    processes: [
      { processId: "p1", label: "Process 1", role: "entry", depth: 3 },
      { processId: "p2", label: "Process 2", role: "intermediate", depth: 5 },
      { processId: "p3", label: "Process 3", role: "exit", depth: 2 },
      { processId: "p4", label: "Process 4", role: "intermediate", depth: 9 },
      { processId: "p5", label: "Process 5", role: "intermediate", depth: 1 },
    ],
    detailLevel: "full",
    version: { ledgerVersion: "v1", astFingerprint: "fp" },
  } as const;

  it("includes cluster at all detail levels and processes at deps+", () => {
    const minimal = toCardAtDetailLevel(baseCard, "minimal");
    assert.ok(minimal.cluster);
    assert.strictEqual(minimal.processes, undefined);

    const signature = toCardAtDetailLevel(baseCard, "signature");
    assert.ok(signature.cluster);
    assert.strictEqual(signature.processes, undefined);

    const deps = toCardAtDetailLevel(baseCard, "deps");
    assert.ok(deps.cluster);
    assert.ok(Array.isArray(deps.processes));
    assert.strictEqual(deps.processes.length, SYMBOL_CARD_MAX_PROCESSES);

    const full = toCardAtDetailLevel(baseCard, "full");
    assert.ok(full.cluster);
    assert.ok(Array.isArray(full.processes));
    assert.strictEqual(full.processes.length, SYMBOL_CARD_MAX_PROCESSES);
  });

  it("includes cluster/process in ETag hashing", () => {
    const without = { ...baseCard };
    // @ts-expect-error - test deletes optional enriched fields
    delete without.cluster;
    // @ts-expect-error - test deletes optional enriched fields
    delete without.processes;

    const etagWithout = hashCard(without);
    const etagWith = hashCard(baseCard);
    assert.notStrictEqual(etagWithout, etagWith);
  });

  it("adds fixed token increments and enforces max processes", () => {
    const without = { ...baseCard };
    // @ts-expect-error - test deletes optional enriched fields
    delete without.cluster;
    // @ts-expect-error - test deletes optional enriched fields
    delete without.processes;

    const tokensWithout = estimateTokens([without]);
    const tokensWith = estimateTokens([baseCard]);

    assert.strictEqual(tokensWith - tokensWithout, 75);
  });
});

