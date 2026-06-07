import { describe, it } from "node:test";
import assert from "node:assert";

describe("metrics payload fingerprint", () => {
  it("is stable across row order and updatedAt changes", async () => {
    const metrics = (await import(
      "../../dist/graph/metrics.js"
    )) as Record<string, unknown>;
    const buildFingerprint =
      metrics._buildMetricsPayloadFingerprintForTesting as unknown;

    assert.equal(typeof buildFingerprint, "function");

    const first = (
      buildFingerprint as (rows: unknown[]) => {
        metricsHash: string;
        rowCount: number;
      }
    )([
      {
        symbolId: "b",
        fanIn: 2,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: '["tests/b.test.ts","tests/a.test.ts"]',
        canonicalTestJson: '{"path":"tests/b.test.ts","distance":1}',
        pageRank: 0,
        kCore: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        symbolId: "a",
        fanIn: 0,
        fanOut: 3,
        churn30d: 5,
        testRefsJson: "[]",
        canonicalTestJson: null,
        pageRank: 0,
        kCore: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const second = (
      buildFingerprint as (rows: unknown[]) => {
        metricsHash: string;
        rowCount: number;
      }
    )([
      {
        symbolId: "a",
        fanIn: 0,
        fanOut: 3,
        churn30d: 5,
        testRefsJson: "[]",
        canonicalTestJson: null,
        pageRank: 0,
        kCore: 0,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        symbolId: "b",
        fanIn: 2,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: '["tests/a.test.ts","tests/b.test.ts"]',
        canonicalTestJson: '{"distance":1,"path":"tests/b.test.ts"}',
        pageRank: 0,
        kCore: 0,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    assert.equal(first.rowCount, 2);
    assert.equal(second.rowCount, 2);
    assert.equal(second.metricsHash, first.metricsHash);
  });

  it("changes when metrics values change", async () => {
    const metrics = (await import(
      "../../dist/graph/metrics.js"
    )) as Record<string, unknown>;
    const buildFingerprint =
      metrics._buildMetricsPayloadFingerprintForTesting as (
        rows: unknown[],
      ) => { metricsHash: string; rowCount: number };

    assert.equal(typeof buildFingerprint, "function");

    const baseline = buildFingerprint([
      {
        symbolId: "a",
        fanIn: 1,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: "[]",
        canonicalTestJson: null,
        pageRank: 0,
        kCore: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const changed = buildFingerprint([
      {
        symbolId: "a",
        fanIn: 2,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: "[]",
        canonicalTestJson: null,
        pageRank: 0,
        kCore: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    assert.notEqual(changed.metricsHash, baseline.metricsHash);
  });

  it("supports a caller-verified canonical JSON fast path", async () => {
    const metrics = (await import(
      "../../dist/graph/metrics.js"
    )) as Record<string, unknown>;
    const buildFingerprint =
      metrics._buildMetricsPayloadFingerprintForTesting as (
        rows: unknown[],
        options?: { assumeCanonicalJson?: boolean },
      ) => { metricsHash: string; rowCount: number };

    const canonical = buildFingerprint(
      [
        {
          symbolId: "a",
          fanIn: 1,
          fanOut: 1,
          churn30d: 0,
          testRefsJson: '["tests/a.test.ts","tests/b.test.ts"]',
          canonicalTestJson: '{"distance":1,"file":"tests/a.test.ts","proximity":0.5,"symbolId":"a"}',
          pageRank: 0,
          kCore: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { assumeCanonicalJson: true },
    );
    const nonCanonical = buildFingerprint(
      [
        {
          symbolId: "a",
          fanIn: 1,
          fanOut: 1,
          churn30d: 0,
          testRefsJson: '["tests/b.test.ts","tests/a.test.ts"]',
          canonicalTestJson: '{"symbolId":"a","proximity":0.5,"file":"tests/a.test.ts","distance":1}',
          pageRank: 0,
          kCore: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { assumeCanonicalJson: true },
    );

    assert.notEqual(nonCanonical.metricsHash, canonical.metricsHash);
  });
});
