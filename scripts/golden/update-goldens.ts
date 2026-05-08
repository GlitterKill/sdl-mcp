#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { RustAdapter } from "../../dist/indexer/adapter/rust.js";
import { CAdapter } from "../../dist/indexer/adapter/c.js";
import { CppAdapter } from "../../dist/indexer/adapter/cpp.js";
import { PhpAdapter } from "../../dist/indexer/adapter/php.js";
import { KotlinAdapter } from "../../dist/indexer/adapter/kotlin.js";
import { ShellAdapter } from "../../dist/indexer/adapter/shell.js";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const PROJECT_ROOT = resolve(SCRIPT_DIR, "../..");

const ADAPTERS: Record<string, any> = {
  rust: RustAdapter,
  c: CAdapter,
  cpp: CppAdapter,
  php: PhpAdapter,
  kotlin: KotlinAdapter,
  shell: ShellAdapter,
};

type Language = keyof typeof ADAPTERS;

interface AdapterMethods {
  extractSymbols: (tree: unknown, code: string, filePath: string) => unknown[];
  extractImports: (tree: unknown, code: string, filePath: string) => unknown[];
  extractCalls: (
    tree: unknown,
    code: string,
    filePath: string,
    symbols: unknown[],
  ) => unknown[];
  parse: (code: string, filePath: string) => unknown;
  getParser?: () => unknown;
}

interface GoldenFileSpec {
  language: Language;
  sourceFile: string;
  goldenFile: string;
  extractMethod: "symbols" | "imports" | "calls";
  requiresSymbols?: boolean;
}

type ProcessResult = "success" | "failed" | "skipped";

const FIXTURE_PATH_PATTERN =
  /(?:[A-Za-z]:)?(?:[\\/][^:\r\n]*)?[\\/]?tests[\\/]fixtures[\\/](rust|c|cpp|php|kotlin|shell)[\\/]([^:\r\n]+)/gi;

function getAdapter(language: string): AdapterMethods | null {
  const AdapterClass = ADAPTERS[language];
  if (!AdapterClass) {
    return null;
  }
  return new AdapterClass();
}

function getStableFixturePath(spec: GoldenFileSpec): string {
  return `tests/fixtures/${spec.language}/${spec.sourceFile}`;
}

function getUnavailableReason(
  spec: GoldenFileSpec,
  adapter: AdapterMethods,
): string | null {
  if (spec.language === "kotlin" && adapter.getParser && !adapter.getParser()) {
    return "tree-sitter-kotlin grammar not available on this platform";
  }
  return null;
}

function normalizeFixturePaths(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      FIXTURE_PATH_PATTERN,
      (_match, language: string, filePath: string) =>
        `tests/fixtures/${language.toLowerCase()}/${filePath.replace(/\\/g, "/")}`,
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeFixturePaths(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeFixturePaths(entry),
      ]),
    );
  }

  return value;
}

function generateGoldenFile(spec: GoldenFileSpec): ProcessResult {
  const adapter = getAdapter(spec.language);
  if (!adapter) {
    console.log(`⏭️  Skipping ${spec.language} - adapter not available`);
    return "skipped";
  }

  const unavailableReason = getUnavailableReason(spec, adapter);
  if (unavailableReason) {
    console.log(
      `[skip] ${spec.language}/${spec.goldenFile} - ${unavailableReason}`,
    );
    return "skipped";
  }

  const fixturesDir = resolve(PROJECT_ROOT, "tests/fixtures", spec.language);
  const sourcePath = join(fixturesDir, spec.sourceFile);
  const goldenPath = join(fixturesDir, spec.goldenFile);

  if (!existsSync(sourcePath)) {
    console.error(`❌ Source file not found: ${spec.language}/${spec.sourceFile}`);
    return "failed";
  }

  const code = readFileSync(sourcePath, "utf-8");
  const fixturePath = getStableFixturePath(spec);
  const tree = adapter.parse(code, fixturePath);

  if (!tree) {
    console.error(`❌ Failed to parse ${sourcePath}`);
    return "failed";
  }

  let data: unknown[];

  if (spec.extractMethod === "symbols") {
    data = adapter.extractSymbols(tree, code, fixturePath);
  } else if (spec.extractMethod === "imports") {
    data = adapter.extractImports(tree, code, fixturePath);
  } else if (spec.extractMethod === "calls") {
    if (!spec.requiresSymbols) {
      console.error(`❌ ${spec.sourceFile} requires symbols but not specified`);
      return "failed";
    }
    const symbols = adapter.extractSymbols(tree, code, fixturePath);
    data = adapter.extractCalls(tree, code, fixturePath, symbols);
  } else {
    console.error(`❌ Unknown extract method: ${spec.extractMethod}`);
    return "failed";
  }

  mkdirSync(resolve(goldenPath, ".."), { recursive: true });
  writeFileSync(goldenPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(
    `✅ Generated ${spec.language}/${spec.goldenFile} (${data.length} items)`,
  );
  return "success";
}

function validateGoldenFile(spec: GoldenFileSpec): ProcessResult {
  const adapter = getAdapter(spec.language);
  if (!adapter) {
    console.error(`❌ ${spec.language} adapter not available`);
    return "failed";
  }

  const unavailableReason = getUnavailableReason(spec, adapter);
  if (unavailableReason) {
    console.log(
      `[skip] ${spec.language}/${spec.goldenFile} - ${unavailableReason}`,
    );
    return "skipped";
  }

  const fixturesDir = resolve(PROJECT_ROOT, "tests/fixtures", spec.language);
  const sourcePath = join(fixturesDir, spec.sourceFile);
  const goldenPath = join(fixturesDir, spec.goldenFile);

  if (!existsSync(sourcePath)) {
    console.error(`❌ Source file not found: ${spec.language}/${spec.sourceFile}`);
    return "failed";
  }

  if (!existsSync(goldenPath)) {
    console.error(
      `❌ Missing golden file: ${spec.language}/${spec.goldenFile}`,
    );
    return "failed";
  }

  const code = readFileSync(sourcePath, "utf-8");
  const fixturePath = getStableFixturePath(spec);
  const tree = adapter.parse(code, fixturePath);

  if (!tree) {
    console.error(`❌ Failed to parse ${sourcePath}`);
    return "failed";
  }

  let data: unknown[];

  if (spec.extractMethod === "symbols") {
    data = adapter.extractSymbols(tree, code, fixturePath);
  } else if (spec.extractMethod === "imports") {
    data = adapter.extractImports(tree, code, fixturePath);
  } else if (spec.extractMethod === "calls") {
    const symbols = adapter.extractSymbols(tree, code, fixturePath);
    data = adapter.extractCalls(tree, code, fixturePath, symbols);
  } else {
    console.error(`❌ Unknown extract method: ${spec.extractMethod}`);
    return "failed";
  }

  const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

  const actualStr = JSON.stringify(normalizeFixturePaths(data), null, 2);
  const goldenStr = JSON.stringify(normalizeFixturePaths(golden), null, 2);

  if (actualStr !== goldenStr) {
    console.error(`❌ ${spec.language}/${spec.goldenFile} - MISMATCH`);
    console.log(`   Expected ${golden.length} items, got ${data.length} items`);
    return "failed";
  }

  console.log(
    `✅ Validated ${spec.language}/${spec.goldenFile} (${data.length} items)`,
  );
  return "success";
}

function getGoldenSpecs(): GoldenFileSpec[] {
  const specs: GoldenFileSpec[] = [];

  for (const [language, adapterClass] of Object.entries(ADAPTERS)) {
    const fixturesDir = resolve(PROJECT_ROOT, "tests/fixtures", language);
    if (!existsSync(fixturesDir)) {
      continue;
    }

    if (language === "c") {
      specs.push({
        language: "c",
        sourceFile: "symbols.c",
        goldenFile: "expected-symbols.c.json",
        extractMethod: "symbols",
      });
      specs.push({
        language: "c",
        sourceFile: "symbols.h",
        goldenFile: "expected-symbols.h.json",
        extractMethod: "symbols",
      });
      specs.push({
        language: "c",
        sourceFile: "imports.c",
        goldenFile: "expected-imports.c.json",
        extractMethod: "imports",
      });
      specs.push({
        language: "c",
        sourceFile: "calls.c",
        goldenFile: "expected-calls.c.json",
        extractMethod: "calls",
        requiresSymbols: true,
      });
    } else if (language === "cpp") {
      specs.push({
        language: "cpp",
        sourceFile: "symbols.cpp",
        goldenFile: "expected-symbols.cpp.json",
        extractMethod: "symbols",
      });
      specs.push({
        language: "cpp",
        sourceFile: "symbols.hpp",
        goldenFile: "expected-symbols.hpp.json",
        extractMethod: "symbols",
      });
      specs.push({
        language: "cpp",
        sourceFile: "imports.cpp",
        goldenFile: "expected-imports.cpp.json",
        extractMethod: "imports",
      });
      specs.push({
        language: "cpp",
        sourceFile: "calls.cpp",
        goldenFile: "expected-calls.cpp.json",
        extractMethod: "calls",
        requiresSymbols: true,
      });
    } else {
      const ext =
        language === "rust"
          ? "rs"
          : language === "shell"
            ? "sh"
            : language === "kotlin"
              ? "kt"
              : language;
      specs.push({
        language,
        sourceFile: `symbols.${ext}`,
        goldenFile: "expected-symbols.json",
        extractMethod: "symbols",
      });
      specs.push({
        language,
        sourceFile: `imports.${ext}`,
        goldenFile: "expected-imports.json",
        extractMethod: "imports",
      });
      specs.push({
        language,
        sourceFile: `calls.${ext}`,
        goldenFile: "expected-calls.json",
        extractMethod: "calls",
        requiresSymbols: true,
      });
    }
  }

  return specs;
}

function main(): void {
  const args = process.argv.slice(2);
  const mode = args[0] || "validate";
  const filterLanguage = args[1] as Language | undefined;

  console.log("=".repeat(60));
  console.log("SDL-MCP Golden File Manager");
  console.log("=".repeat(60));
  console.log(`Mode: ${mode}`);
  if (filterLanguage) {
    console.log(`Language: ${filterLanguage}`);
  }
  console.log("=".repeat(60));

  if (mode !== "generate" && mode !== "validate") {
    console.error("❌ Invalid mode. Use: 'generate' or 'validate'");
    process.exit(1);
  }

  const specs = getGoldenSpecs();
  const filteredSpecs = filterLanguage
    ? specs.filter((s) => s.language === filterLanguage)
    : specs;

  if (filterLanguage && filteredSpecs.length === 0) {
    console.error(`❌ No golden file specs found for language: ${filterLanguage}`);
    process.exit(1);
  }

  console.log(`\nProcessing ${filteredSpecs.length} golden file specs...\n`);

  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const spec of filteredSpecs) {
    try {
      const result =
        mode === "generate"
          ? generateGoldenFile(spec)
          : validateGoldenFile(spec);

      if (result === "success") {
        successCount++;
      } else if (result === "skipped") {
        skipCount++;
      } else {
        failCount++;
      }
    } catch (error) {
      console.error(
        `❌ Error processing ${spec.language}/${spec.goldenFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failCount++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Summary");
  console.log("=".repeat(60));
  console.log(`Success: ${successCount}`);
  console.log(`Skipped: ${skipCount}`);
  console.log(`Failed: ${failCount}`);
  console.log("=".repeat(60));

  if (failCount > 0) {
    if (mode === "validate") {
      console.log(
        "\n💡 Tip: Run 'npx tsx scripts/golden/update-goldens.ts generate' to regenerate failing files",
      );
    }
    process.exit(1);
  }
}

main();
