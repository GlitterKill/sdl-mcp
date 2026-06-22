import assert from "node:assert/strict";
import test from "node:test";

import { lspRecommendationForLanguage } from "../../src/cli/setup-wizard/lsp.ts";

test("LSP registry includes safe install commands where available", () => {
  assert.deepEqual(lspRecommendationForLanguage("ts")?.installCommand, [
    "npm",
    "install",
    "-g",
    "typescript",
    "typescript-language-server",
  ]);
  assert.deepEqual(lspRecommendationForLanguage("py")?.installCommand, [
    "npm",
    "install",
    "-g",
    "pyright",
  ]);
  assert.deepEqual(lspRecommendationForLanguage("go")?.installCommand, [
    "go",
    "install",
    "golang.org/x/tools/gopls@latest",
  ]);
  assert.deepEqual(lspRecommendationForLanguage("rs")?.installCommand, [
    "rustup",
    "component",
    "add",
    "rust-analyzer",
  ]);
});

test("unsafe LSP installs return manual commands only", () => {
  assert.equal(lspRecommendationForLanguage("cpp")?.safeAutoInstall, false);
  assert.match(lspRecommendationForLanguage("java")?.manualCommand ?? "", /JDTLS/);
});
