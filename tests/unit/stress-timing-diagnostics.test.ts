import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MetricsCollector } from "../stress/infra/metrics-collector.ts";
import { validateToolResult } from "../stress/infra/result-validator.ts";
import { mergeToolDiagnostics } from "../stress/infra/types.ts";

describe("stress timing diagnostics", () => {
  it("aggregates index.refresh timing diagnostics into report-ready summaries", () => {
    const collector = new MetricsCollector();

    collector.recordToolTimingDiagnostics("sdl.index.refresh", {
      timings: {
        totalMs: 120,
        phases: {
          scanRepo: 10,
          pass1: 60,
        },
      },
    });
    collector.recordToolTimingDiagnostics("sdl.index.refresh", {
      timings: {
        totalMs: 240,
        phases: {
          scanRepo: 20,
          pass1: 140,
        },
      },
    });

    const diagnostics = collector.getToolTimingDiagnostics();
    const refresh = diagnostics["sdl.index.refresh"];
    assert.ok(refresh);
    assert.equal(refresh.timings.totalMs.count, 2);
    assert.equal(refresh.timings.totalMs.p50, 120);
    assert.equal(refresh.timings.totalMs.p95, 240);
    assert.equal(refresh.timings.phases.scanRepo.p50, 10);
    assert.equal(refresh.timings.phases.pass1.max, 140);
  });

  it("keeps the slowest diagnostic profile when merging scenario rounds", () => {
    const merged = mergeToolDiagnostics([
      {
        "sdl.index.refresh": {
          timings: {
            totalMs: {
              count: 2,
              min: 100,
              p50: 110,
              p95: 140,
              p99: 140,
              max: 140,
              avg: 120,
            },
            phases: {},
          },
        },
      },
      {
        "sdl.index.refresh": {
          timings: {
            totalMs: {
              count: 3,
              min: 200,
              p50: 220,
              p95: 320,
              p99: 320,
              max: 320,
              avg: 247,
            },
            phases: {},
          },
        },
      },
    ]);

    assert.equal(merged["sdl.index.refresh"].timings.totalMs.p95, 320);
  });

  it("requires diagnostics when stress refresh requests opt in", () => {
    const checks = validateToolResult(
      "sdl.index.refresh",
      { includeDiagnostics: true },
      {
        versionId: "v123",
        diagnostics: {
          timings: {
            totalMs: 180,
            phases: {
              scanRepo: 10,
              pass1: 90,
            },
          },
        },
      },
    );

    assert.equal(
      checks.every((check) => check.passed),
      true,
    );
  });
});
