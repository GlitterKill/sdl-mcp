import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildClusterSearchText } from "../../dist/db/ladybug-clusters.js";
import { buildProcessSearchText } from "../../dist/db/ladybug-processes.js";
import {
  buildFileSummaryHybridPayload,
  buildFileSummarySearchText,
} from "../../dist/db/ladybug-file-summaries.js";

describe("buildClusterSearchText", () => {
  it("should produce cluster-prefixed text with label and member names", () => {
    const text = buildClusterSearchText("Auth Module", [
      "login",
      "logout",
      "validateToken",
    ]);
    assert.ok(
      text.startsWith("cluster:"),
      `expected cluster: prefix, got: ${text}`,
    );
    assert.ok(text.includes("Auth Module"), "label missing");
    assert.ok(text.includes("members:"), "members: section missing");
    assert.ok(text.includes("login"), "login missing");
    assert.ok(text.includes("logout"), "logout missing");
    assert.ok(text.includes("validateToken"), "validateToken missing");
  });

  it("should limit member names to 20", () => {
    const names = Array.from({ length: 30 }, (_, i) => `symbol${i}`);
    const text = buildClusterSearchText("Big Cluster", names);
    // symbol0..symbol19 are included; symbol20..symbol29 are dropped
    assert.ok(text.includes("symbol19"), "symbol19 should be present");
    assert.ok(!text.includes("symbol20"), "symbol20 should be dropped");
  });

  it("should handle empty member names gracefully", () => {
    const text = buildClusterSearchText("Empty Cluster", []);
    assert.ok(text.includes("cluster:"), "cluster: prefix missing");
    assert.ok(text.includes("Empty Cluster"), "label missing");
  });

  it("should trim the result", () => {
    const text = buildClusterSearchText("Trim Test", []);
    assert.equal(
      text,
      text.trim(),
      "result should not have leading/trailing whitespace",
    );
  });

  it("should include exactly 20 member names when list has 20", () => {
    const names = Array.from({ length: 20 }, (_, i) => `fn${i}`);
    const text = buildClusterSearchText("Exact20", names);
    assert.ok(text.includes("fn0"), "fn0 missing");
    assert.ok(text.includes("fn19"), "fn19 missing");
  });
});

describe("buildProcessSearchText", () => {
  it("should produce process-prefixed text with label, entry, and steps", () => {
    const text = buildProcessSearchText("Request Flow", "handleRequest", [
      "validate",
      "process",
      "respond",
    ]);
    assert.ok(
      text.startsWith("process:"),
      `expected process: prefix, got: ${text}`,
    );
    assert.ok(text.includes("Request Flow"), "label missing");
    assert.ok(text.includes("entry:"), "entry: section missing");
    assert.ok(text.includes("handleRequest"), "entrySymbolName missing");
    assert.ok(text.includes("steps:"), "steps: section missing");
    assert.ok(text.includes("validate"), "validate step missing");
    assert.ok(text.includes("process"), "process step missing");
    assert.ok(text.includes("respond"), "respond step missing");
  });

  it("should limit step names to 15", () => {
    const names = Array.from({ length: 20 }, (_, i) => `step${i}`);
    const text = buildProcessSearchText("Long Process", "entryFn", names);
    // step0..step14 included; step15..step19 dropped
    assert.ok(text.includes("step14"), "step14 should be present");
    assert.ok(!text.includes("step15"), "step15 should be dropped");
  });

  it("should handle empty step names", () => {
    const text = buildProcessSearchText("Single Step", "start", []);
    assert.ok(text.includes("process:"), "process: prefix missing");
    assert.ok(text.includes("Single Step"), "label missing");
    assert.ok(text.includes("entry:"), "entry: section missing");
    assert.ok(text.includes("start"), "entrySymbolName missing");
    assert.ok(text.includes("steps:"), "steps: section missing");
  });

  it("should trim the result", () => {
    const text = buildProcessSearchText("Trim", "fn", []);
    assert.equal(text, text.trim());
  });

  it("should include exactly 15 step names when list has 15", () => {
    const names = Array.from({ length: 15 }, (_, i) => `s${i}`);
    const text = buildProcessSearchText("Exact15", "entry", names);
    assert.ok(text.includes("s0"), "s0 missing");
    assert.ok(text.includes("s14"), "s14 missing");
  });
});

describe("buildFileSummarySearchText", () => {
  it("should produce file-prefixed text with path and export names", () => {
    const text = buildFileSummarySearchText("src/auth/login.ts", [
      "login",
      "LoginOptions",
    ]);
    assert.ok(text.startsWith("file:"), `expected file: prefix, got: ${text}`);
    assert.ok(text.includes("src/auth/login.ts"), "file path missing");
    assert.ok(text.includes("exports:"), "exports: section missing");
    assert.ok(text.includes("login"), "login missing");
    assert.ok(text.includes("LoginOptions"), "LoginOptions missing");
  });

  it("should include summary section when summary is provided", () => {
    const text = buildFileSummarySearchText(
      "src/main.ts",
      ["main"],
      "Application entry point",
    );
    assert.ok(text.includes("summary:"), "summary: section missing");
    assert.ok(
      text.includes("Application entry point"),
      "summary content missing",
    );
  });

  it("should omit summary section when summary is undefined", () => {
    const text = buildFileSummarySearchText("src/main.ts", ["main"]);
    assert.ok(!text.includes("summary:"), "summary: section should be absent");
  });

  it("should omit summary section when summary is null", () => {
    const text = buildFileSummarySearchText("src/main.ts", ["main"], null);
    assert.ok(
      !text.includes("summary:"),
      "summary: section should be absent for null",
    );
  });

  it("should limit exported symbol names to 30", () => {
    const names = Array.from({ length: 35 }, (_, i) => `export${i}`);
    const text = buildFileSummarySearchText("src/big.ts", names);
    // export0..export29 included; export30..export34 dropped
    assert.ok(text.includes("export29"), "export29 should be present");
    assert.ok(!text.includes("export30"), "export30 should be dropped");
  });

  it("should handle empty export names", () => {
    const text = buildFileSummarySearchText("src/empty.ts", []);
    assert.ok(text.includes("file:"), "file: prefix missing");
    assert.ok(text.includes("src/empty.ts"), "path missing");
    assert.ok(text.includes("exports:"), "exports: section missing");
  });

  it("should trim the result", () => {
    const text = buildFileSummarySearchText("src/x.ts", []);
    assert.equal(text, text.trim());
  });

  it("should include exactly 30 export names when list has 30", () => {
    const names = Array.from({ length: 30 }, (_, i) => `e${i}`);
    const text = buildFileSummarySearchText("src/exact.ts", names);
    assert.ok(text.includes("e0"), "e0 missing");
    assert.ok(text.includes("e29"), "e29 missing");
  });
});

describe("buildFileSummaryHybridPayload", () => {
  it("builds deterministic file context for hybrid vector payloads", () => {
    const payload = buildFileSummaryHybridPayload({
      relPath: "src/auth/login.ts",
      language: "typescript",
      symbols: [
        {
          name: "login",
          kind: "function",
          exported: true,
          signatureJson: JSON.stringify({
            text: "function login(user: User): Session",
          }),
          summary: "Creates a login session.",
        },
        {
          name: "LoginOptions",
          kind: "interface",
          exported: true,
          signatureJson: JSON.stringify({ text: "interface LoginOptions" }),
          summary: null,
        },
      ],
    });

    assert.ok(payload.includes("File: src/auth/login.ts"));
    assert.ok(payload.includes("Language: typescript"));
    assert.ok(payload.includes("Exports: login, LoginOptions"));
    assert.ok(payload.includes("function login(user: User): Session"));
    assert.ok(payload.includes("Creates a login session."));
  });
});
