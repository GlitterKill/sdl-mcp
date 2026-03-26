import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("release regression guards", () => {
  it("parses card URI symbol segment correctly", () => {
    const source = readSource("src/mcp/resources.ts");

    assert.match(
      source,
      /const\s*\[\s*,\s*,\s*symbolId,\s*versionId\s*\]\s*=\s*match;/,
      "card URI parser should skip repoId capture and read symbolId from group 2",
    );
  });

  it("updates code policy engine from merged repo+app policy before evaluation", () => {
    const source = readSource("src/mcp/tools/code.ts");

    assert.match(
      source,
      /const policyEngine = new PolicyEngine\(\{\s*maxWindowLines:\s*validatedPolicy\.maxWindowLines,\s*maxWindowTokens:\s*validatedPolicy\.maxWindowTokens,\s*requireIdentifiers:\s*validatedPolicy\.requireIdentifiers,\s*allowBreakGlass:\s*validatedPolicy\.allowBreakGlass,/s,
      "code handler should construct PolicyEngine with merged policy values",
    );

    const updateIdx = source.indexOf("const policyEngine = new PolicyEngine({");
    const evaluateIdx = source.indexOf("policyEngine.evaluate(policyContext)");
    assert.ok(
      updateIdx !== -1 && evaluateIdx !== -1 && updateIdx < evaluateIdx,
      "policy engine should be configured before evaluation",
    );
  });

  it("runs native parity checks from source instead of missing dist artifact", () => {
    const source = readSource("package.json");
    assert.match(
      source,
      /"test:native-parity":\s*"node tests\/native\/parity-test\.ts"/,
      "native parity script should execute source test directly via Node strip-types",
    );
  });

  it("defaults install-time indexing config to the Rust engine", () => {
    const configTypesSource = readSource("src/config/types.ts");
    const initSource = readSource("src/cli/commands/init.ts");
    const exampleConfigSource = readSource("config/sdlmcp.config.example.json");
    const schemaSource = readSource("config/sdlmcp.config.schema.json");

    assert.match(
      configTypesSource,
      /engine:\s*z\.enum\(\["typescript", "rust"\]\)\.default\("rust"\)/,
      "Zod config defaults should prefer the Rust indexer",
    );

    assert.match(
      initSource,
      /indexing:\s*\{[\s\S]*engine:\s*"rust"\s+as\s+const,/s,
      "init command should scaffold Rust as the default indexing engine",
    );

    assert.match(
      exampleConfigSource,
      /"engine":\s*"rust"/,
      "example config should advertise the Rust indexer as the default",
    );

    assert.match(
      schemaSource,
      /"engine":\s*\{[\s\S]*"default":\s*"rust"[\s\S]*\}[\s\S]*"default":\s*\{[\s\S]*"engine":\s*"rust"/s,
      "JSON schema should default indexing.engine to rust in both field and object defaults",
    );
  });

  it("keeps the broad CI suite non-native while native-dependent jobs consume built addons", () => {
    const ciSource = readSource(".github/workflows/ci.yml");
    const runTestsSource = readSource("scripts/run-tests.mjs");
    const testsJob = ciSource.match(/tests:\s*[\s\S]*?\n  benchmarks:/)?.[0] ?? "";
    const benchmarksJob =
      ciSource.match(/benchmarks:\s*[\s\S]*?\n  native-build:/)?.[0] ?? "";
    const syncMemoryJob =
      ciSource.match(/sync-memory:\s*[\s\S]*?\n  sync-validation:/)?.[0] ?? "";

    assert.ok(testsJob, "tests job section should be present in ci workflow");
    assert.ok(
      benchmarksJob,
      "benchmarks job section should be present in ci workflow",
    );
    assert.ok(
      syncMemoryJob,
      "sync-memory job section should be present in ci workflow",
    );

    assert.match(
      runTestsSource,
      /SDL_MCP_DISABLE_NATIVE_ADDON:\s*"1"/,
      "generic npm test harness should explicitly disable the native addon to avoid flaky teardown crashes",
    );

    assert.doesNotMatch(
      testsJob,
      /tests:\s*[\s\S]*needs:\s*native-build/s,
      "tests job should not depend on native-build once the generic test harness disables the native addon",
    );

    assert.doesNotMatch(
      testsJob,
      /name:\s*Download native addon artifact[\s\S]*name:\s*\$\{\{\s*matrix\.native-artifact\s*\}\}/s,
      "tests job should not download native artifacts when the generic suite is intentionally non-native",
    );

    assert.doesNotMatch(
      testsJob,
      /SDL_MCP_NATIVE_ADDON_PATH=/s,
      "tests job should not export a native addon path",
    );

    assert.match(
      benchmarksJob,
      /needs:\s*native-build[\s\S]*uses:\s*actions\/download-artifact@v7[\s\S]*name:\s*\$\{\{\s*matrix\.native-artifact\s*\}\}[\s\S]*SDL_MCP_NATIVE_ADDON_PATH=/s,
      "benchmarks job should run against the freshly built native addon",
    );

    assert.match(
      syncMemoryJob,
      /needs:\s*\[[^\]]*tests[^\]]*native-build[^\]]*\][\s\S]*uses:\s*actions\/download-artifact@v7[\s\S]*name:\s*\$\{\{\s*matrix\.native-artifact\s*\}\}[\s\S]*SDL_MCP_NATIVE_ADDON_PATH=/s,
      "sync-memory job should also consume the freshly built native addon",
    );
  });

  it("renames the built native addon to the target-specific artifact name before upload", () => {
    const ciSource = readSource(".github/workflows/ci.yml");

    assert.match(
      ciSource,
      /native-build:[\s\S]*name:\s*Normalize native addon artifact name[\s\S]*SOURCE_ADDON_PATH="native\/sdl-mcp-native\.node"[\s\S]*TARGET_ADDON_PATH="native\/\$\{\{\s*matrix\.addon-file\s*\}\}"[\s\S]*(cp|Copy-Item)\s+"\$SOURCE_ADDON_PATH"\s+"\$TARGET_ADDON_PATH"/s,
      "native-build should copy the unsuffixed napi output to the target-specific addon filename before upload",
    );
  });

  it("compacts successful save-time live index overlays via checkpoint service", () => {
    const source = readSource("src/live-index/coordinator.ts");

    assert.match(
      source,
      /await this\.checkpointService\.checkpointRepo\(/,
      "save flow should invoke checkpoint service after a successful durable patch",
    );

    assert.match(
      source,
      /reason:\s*"save"/,
      "save flow should tag live index compaction with the save reason",
    );

    assert.match(
      source,
      /skipDurablePatch:\s*true/,
      "save flow should compact overlay state without redundantly re-patching the same file",
    );
  });

  it("preserves native Rust symbol identity fields in mapper output", () => {
    const source = readSource("src/indexer/rustIndexer.ts");

    assert.match(
      source,
      /export interface RustExtractedSymbol[\s\S]*symbolId:\s*string;[\s\S]*astFingerprint:\s*string;[\s\S]*summary:\s*string;[\s\S]*invariantsJson:\s*string;[\s\S]*sideEffectsJson:\s*string;[\s\S]*roleTagsJson:\s*string;[\s\S]*searchText:\s*string;/,
      "RustExtractedSymbol should include identity and metadata fields from native output",
    );

    assert.match(
      source,
      /function mapNativeSymbol\(sym: NativeParsedSymbol\): RustExtractedSymbol[\s\S]*symbolId:\s*sym\.symbolId,[\s\S]*astFingerprint:\s*sym\.astFingerprint,[\s\S]*summary:\s*sym\.summary,[\s\S]*invariantsJson:\s*sym\.invariants[\s\S]*sideEffectsJson:\s*sym\.sideEffects[\s\S]*roleTagsJson:\s*sym\.roleTags[\s\S]*searchText:\s*typeof sym\.searchText === "string" \? sym\.searchText : "",/,
      "native symbol mapper should pass through symbol identity and metadata",
    );
  });

  it("uses native Rust symbol IDs/fingerprints and full-file content in Rust pass-1", () => {
    const source = readSource("src/indexer/parser/rust-process-file.ts");

    assert.match(
      source,
      /const filePath = join\(repoRoot, fileMeta\.path\);\s*let content:\s*string;\s*try\s*\{\s*content = await readFileAsync\(filePath, "utf-8"\);/s,
      "Rust pass-1 should read file content for metadata generation in all files",
    );

    assert.match(
      source,
      /astFingerprint:\s*extracted\.astFingerprint,\s*symbolId:\s*extracted\.symbolId,/,
      "Rust pass-1 should use native symbol identity instead of regenerating",
    );
  });

  it("keeps native enrichment metadata compatible across legacy, TS, and sync paths", () => {
    const buildRowsSource = readSource("src/indexer/parser/build-rows.ts");

    const syncTypesSource = readSource("src/sync/types.ts");
    const syncSource = readSource("src/sync/sync.ts");

    assert.match(
      buildRowsSource,
      /const\s+nativeRoleTagsJson\s*=\s*typeof detail\.nativeRoleTagsJson === "string"\s*\?\s*detail\.nativeRoleTagsJson\.trim\(\)\s*:\s*"";\s*const\s+nativeSearchText\s*=\s*typeof detail\.nativeSearchText === "string"\s*\?\s*detail\.nativeSearchText\.trim\(\)\s*:\s*"";/s,
      "Shared build-rows should tolerate older native addons that omit enrichment fields",
    );

    assert.match(
      buildRowsSource,
      /roleTagsJson,\s*searchText,\s*updatedAt:/s,
      "Shared build-rows should persist derived search metadata for both TS and Rust paths",
    );

    assert.match(
      syncTypesSource,
      /role_tags_json: string \| null;\s*search_text: string \| null;/s,
      "sync state type should carry enrichment metadata",
    );

    assert.match(
      syncSource,
      /role_tags_json:\s*s\.roleTagsJson\s*\?\?\s*null,\s*search_text:\s*s\.searchText\s*\?\?\s*null,/s,
      "artifact export should serialize enrichment metadata",
    );

    assert.match(
      syncSource,
      /const \{ roleTagsJson, searchText \} = resolveSymbolEnrichment\(\{[\s\S]*nativeRoleTagsJson:\s*symbol\.role_tags_json,[\s\S]*nativeSearchText:\s*symbol\.search_text,[\s\S]*}\);/s,
      "artifact import should preserve or rebuild enrichment metadata",
    );
  });

  it("uses absolute end line for code window truncation resume cursor", () => {
    const source = readSource("src/mcp/tools/code.ts");

    assert.match(
      source,
      /howToResume:\s*\{\s*type:\s*"cursor"\s+as\s+const,\s*value:\s*windowResult\.actualRange\.endLine,\s*\}/s,
      "code truncation cursor should use absolute line numbers",
    );
  });

  it("merges repo policy overrides in slice policy evaluation", () => {
    const source = readSource("src/mcp/tools/slice.ts");

    assert.match(
      source,
      /const mergedPolicy = PolicyConfigSchema\.parse\(\{\s*\.\.\.config\.policy,\s*\.\.\.\(repoConfig\.policy \?\? \{\}\),\s*}\);/s,
      "slice handler should merge app policy with repo overrides",
    );

    assert.match(
      source,
      /policyEngine\.updateConfig\(\{\s*maxWindowLines:\s*mergedPolicy\.maxWindowLines,\s*maxWindowTokens:\s*mergedPolicy\.maxWindowTokens,\s*requireIdentifiers:\s*mergedPolicy\.requireIdentifiers,\s*allowBreakGlass:\s*mergedPolicy\.allowBreakGlass,/s,
      "slice handler should evaluate using merged policy values",
    );
  });

  it("uses a published optional tokenizers version compatible with clean installs", () => {
    const source = readSource("package.json");

    assert.match(
      source,
      /"tokenizers":\s*"[\^~]?0\.13\.\d+[\w.-]*"/,
      "package.json should pin optional tokenizers to a published npm range",
    );

    assert.doesNotMatch(
      source,
      /"tokenizers":\s*"[\^~]?0\.22\.0"/,
      "package.json should not reference an unpublished tokenizers range",
    );
  });

  it("downloads nomic model to the runtime cache location, not bundled models dir", () => {
    const source = readSource("scripts/download-models.mjs");

    assert.match(
      source,
      /function getModelCacheDir\(\)/,
      "download-models should resolve the platform cache directory",
    );

    assert.match(
      source,
      /"nomic-embed-text-v1\.5":\s*\{[\s\S]*dir:\s*join\(getModelCacheDir\(\),\s*"nomic-embed-text-v1\.5"\)/,
      "nomic downloads should target the runtime cache path used by model resolution",
    );

    assert.doesNotMatch(
      source,
      /"nomic-embed-text-v1\.5":\s*\{[\s\S]*dir:\s*join\(ROOT,\s*"models",\s*"nomic-embed-text-v1\.5"\)/,
      "nomic downloads should not be written to the bundled models directory",
    );
  });

  it("rebuilds kuzu during test setup when npm ci used --ignore-scripts", () => {
    const source = readSource("scripts/run-tests.mjs");

    assert.match(
      source,
      /const kuzuEntryPath = resolve\(repoRoot, "node_modules", "kuzu", "index\.mjs"\);/,
      "test runner should check for kuzu ESM entrypoint before initializing LadybugDB",
    );

    assert.match(
      source,
      /if \(!existsSync\(kuzuEntryPath\)\) \{[\s\S]*npm", "rebuild", "kuzu"[\s\S]*\}/,
      "test runner should rebuild kuzu when postinstall artifacts are missing",
    );
  });

  it("rebuilds tree-sitter packages when native bindings are missing", () => {
    const source = readSource("scripts/run-tests.mjs");

    assert.match(
      source,
      /await import\('tree-sitter'\)/,
      "test runner should probe tree-sitter loadability before running tests",
    );

    assert.match(
      source,
      /name === "tree-sitter" \|\| name\.startsWith\("tree-sitter-"\)/,
      "test runner should discover tree-sitter packages from dependencies",
    );

    assert.match(
      source,
      /npm", "rebuild", \.\.\.treeSitterPackages/,
      "test runner should rebuild all tree-sitter packages when probe fails",
    );
  });

  it("policy get/set merges with app policy without clobbering overrides", () => {
    const source = readSource("src/mcp/tools/policy.ts");

    assert.match(
      source,
      /PolicyConfigSchema\.parse\(\{\s*\.\.\.appConfig\.policy,\s*\.\.\.repoPolicy,\s*}\);/s,
      "policy.get should return effective app+repo policy",
    );

    assert.match(
      source,
      /const mergedOverrides = \{ \.\.\.existingPolicyOverrides, \.\.\.policyPatch \};/,
      "policy.set should only merge patch into existing repo overrides",
    );

    assert.match(
      source,
      /PolicyConfigSchema\.parse\(\{\s*\.\.\.appConfig\.policy,\s*\.\.\.mergedOverrides,\s*}\);/s,
      "policy.set should validate against effective app+repo policy",
    );

    assert.match(
      source,
      /configJson\.policy = mergedOverrides;/,
      "policy.set should persist only repo overrides",
    );
  });
});
