import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..", "..");
const WRAPPERS_DIR = join(REPO_ROOT, "grammar-wrappers");

// Source of truth for wrapper pins. Must match scripts/scaffold-grammar-wrappers.mjs.
// If a wrapper pin changes, update both places; this test guards against drift.
const EXPECTED_PINS: Record<string, { upstream: string; pin: string }> = {
  "sdl-mcp-tree-sitter-bash": { upstream: "tree-sitter-bash", pin: "~0.25.1" },
  "sdl-mcp-tree-sitter-c": { upstream: "tree-sitter-c", pin: "~0.24.1" },
  "sdl-mcp-tree-sitter-c-sharp": {
    upstream: "tree-sitter-c-sharp",
    pin: "0.23.1",
  },
  "sdl-mcp-tree-sitter-cpp": { upstream: "tree-sitter-cpp", pin: "~0.23.4" },
  "sdl-mcp-tree-sitter-go": { upstream: "tree-sitter-go", pin: "~0.25.0" },
  "sdl-mcp-tree-sitter-java": { upstream: "tree-sitter-java", pin: "~0.23.5" },
  "sdl-mcp-tree-sitter-kotlin": {
    upstream: "tree-sitter-kotlin",
    pin: "~0.3.8",
  },
  "sdl-mcp-tree-sitter-php": { upstream: "tree-sitter-php", pin: "~0.24.2" },
  "sdl-mcp-tree-sitter-python": {
    upstream: "tree-sitter-python",
    pin: "~0.25.0",
  },
  "sdl-mcp-tree-sitter-rust": { upstream: "tree-sitter-rust", pin: "~0.24.0" },
  "sdl-mcp-tree-sitter-typescript": {
    upstream: "tree-sitter-typescript",
    pin: "~0.23.2",
  },
};

const EXPECTED_PEER_RANGE = ">=0.21.0 <1.0.0";
const REQUIRED_PEER_NAME = "tree-sitter";

type WrapperManifest = {
  name: string;
  version: string;
  main: string;
  types: string;
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function readManifest(wrapperDir: string): WrapperManifest {
  const raw = readFileSync(
    join(WRAPPERS_DIR, wrapperDir, "package.json"),
    "utf8",
  );
  return JSON.parse(raw) as WrapperManifest;
}

describe("grammar-wrappers manifest drift guard", () => {
  it("wrappers directory contains exactly the 11 expected wrappers", () => {
    if (!existsSync(WRAPPERS_DIR)) {
      throw new Error(
        `grammar-wrappers/ missing — run scripts/scaffold-grammar-wrappers.mjs`,
      );
    }
    const found = readdirSync(WRAPPERS_DIR, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && d.name.startsWith("sdl-mcp-tree-sitter-"),
      )
      .map((d) => d.name)
      .sort();
    const expected = Object.keys(EXPECTED_PINS).sort();
    assert.deepEqual(
      found,
      expected,
      "wrapper directory set drifted from EXPECTED_PINS",
    );
  });

  for (const [wrapperName, { upstream, pin }] of Object.entries(
    EXPECTED_PINS,
  )) {
    describe(wrapperName, () => {
      const manifest = readManifest(wrapperName);

      it("declares the right name and entrypoints", () => {
        assert.equal(manifest.name, wrapperName);
        assert.equal(manifest.main, "index.js");
        assert.equal(manifest.types, "index.d.ts");
      });

      it(`pins upstream ${upstream}@${pin} via alias`, () => {
        const alias = manifest.dependencies?.["upstream-grammar"];
        assert.ok(alias, `missing dependencies["upstream-grammar"]`);
        assert.equal(alias, `npm:${upstream}@${pin}`);
      });

      it("bundles the upstream dependency", () => {
        assert.ok(
          Array.isArray(manifest.bundleDependencies) &&
            manifest.bundleDependencies.includes("upstream-grammar"),
          `bundleDependencies must include "upstream-grammar" — peer warnings leak otherwise`,
        );
      });

      it(`declares permissive optional peer ${REQUIRED_PEER_NAME}@${EXPECTED_PEER_RANGE}`, () => {
        const peer = manifest.peerDependencies?.[REQUIRED_PEER_NAME];
        assert.equal(
          peer,
          EXPECTED_PEER_RANGE,
          `peer range must accept keqingmoe@0.26.x; got ${peer}`,
        );
        const optional =
          manifest.peerDependenciesMeta?.[REQUIRED_PEER_NAME]?.optional;
        assert.equal(
          optional,
          true,
          `peer ${REQUIRED_PEER_NAME} must be marked optional`,
        );
      });
    });
  }
});
