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
}

interface GoldenFileSpec {
  language: Language;
  sourceFile: string;
  goldenFile: string;
  extractMethod: "symbols" | "imports" | "calls";
  requiresSymbols?: boolean;
}

function getAdapter(language: string): AdapterMethods | null {
  const AdapterClass = ADAPTERS[language];
  if (!AdapterClass) {
    return null;
  }
  return new AdapterClass();
}

function generateGoldenFile(spec: GoldenFileSpec): void {
  const adapter = getAdapter(spec.language);
  if (!adapter) {
    console.log(`⏭️  Skipping ${spec.language} - adapter not available`);
    return;
  }

  const fixturesDir = resolve(PROJECT_ROOT, "tests/fixtures", spec.language);
  const sourcePath = join(fixturesDir, spec.sourceFile);
  const goldenPath = join(fixturesDir, spec.goldenFile);

  if (!existsSync(sourcePath)) {
    console.log(`⏭️  Skipping ${spec.sourceFile} - source file not found`);
    return;
  }

  const code = readFileSync(sourcePath, "utf-8");
  const tree = adapter.parse(code, sourcePath);

  if (!tree) {
    console.error(`❌ Failed to parse ${sourcePath}`);
    return;
  }

  let data: unknown[];

  if (spec.extractMethod === "symbols") {
    data = adapter.extractSymbols(tree, code, sourcePath);
  } else if (spec.extractMethod === "imports") {
    data = adapter.extractImports(tree, code, sourcePath);
  } else if (spec.extractMethod === "calls") {
    if (!spec.requiresSymbols) {
      console.error(`❌ ${spec.sourceFile} requires symbols but not specified`);
      return;
    }
    const symbols = adapter.extractSymbols(tree, code, sourcePath);
    data = adapter.extractCalls(tree, code, sourcePath, symbols);
  } else {
    console.error(`❌ Unknown extract method: ${spec.extractMethod}`);
    return;
  }

  mkdirSync(resolve(goldenPath, ".."), { recursive: true });
  writeFileSync(goldenPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(
    `✅ Generated ${spec.language}/${spec.goldenFile} (${data.length} items)`,
  );
}

function validateGoldenFile(spec: GoldenFileSpec): boolean {
  const adapter = getAdapter(spec.language);
  if (!adapter) {
    console.log(`⏭️  Skipping ${spec.language} - adapter not available`);
    return true;
  }

  const fixturesDir = resolve(PROJECT_ROOT, "tests/fixtures", spec.language);
  const sourcePath = join(fixturesDir, spec.sourceFile);
  const goldenPath = join(fixturesDir, spec.goldenFile);

  if (!existsSync(sourcePath)) {
    console.log(`⏭️  Skipping ${spec.sourceFile} - source file not found`);
    return true;
  }

  if (!existsSync(goldenPath)) {
    console.error(
      `❌ Missing golden file: ${spec.language}/${spec.goldenFile}`,
    );
    return false;
  }

  const code = readFileSync(sourcePath, "utf-8");
  const tree = adapter.parse(code, sourcePath);

  if (!tree) {
    console.error(`❌ Failed to parse ${sourcePath}`);
    return false;
  }

  let data: unknown[];

  if (spec.extractMethod === "symbols") {
    data = adapter.extractSymbols(tree, code, sourcePath);
  } else if (spec.extractMethod === "imports") {
    data = adapter.extractImports(tree, code, sourcePath);
  } else if (spec.extractMethod === "calls") {
    const symbols = adapter.extractSymbols(tree, code, sourcePath);
    data = adapter.extractCalls(tree, code, sourcePath, symbols);
  } else {
    console.error(`❌ Unknown extract method: ${spec.extractMethod}`);
    return false;
  }

  const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

  const actualStr = JSON.stringify(data, null, 2);
  const goldenStr = JSON.stringify(golden, null, 2);

  if (actualStr !== goldenStr) {
    console.error(`❌ ${spec.language}/${spec.goldenFile} - MISMATCH`);
    console.log(`   Expected ${golden.length} items, got ${data.length} items`);
    return false;
  }

  console.log(
    `✅ Validated ${spec.language}/${spec.goldenFile} (${data.length} items)`,
  );
  return true;
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

  console.log(`\nProcessing ${filteredSpecs.length} golden file specs...\n`);

  let successCount = 0;
  let failCount = 0;

  for (const spec of filteredSpecs) {
    try {
      if (mode === "generate") {
        generateGoldenFile(spec);
        successCount++;
      } else {
        if (validateGoldenFile(spec)) {
          successCount++;
        } else {
          failCount++;
        }
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
  console.log(`Failed: ${failCount}`);
  console.log("=".repeat(60));

  if (failCount > 0 && mode === "validate") {
    console.log(
      "\n💡 Tip: Run 'npx tsx scripts/golden/update-goldens.ts generate' to regenerate failing files",
    );
    process.exit(1);
  }
}

main();
