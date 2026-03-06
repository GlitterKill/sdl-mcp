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
      /"test:native-parity":\s*"node --import tsx tests\/native\/parity-test\.ts"/,
      "native parity script should execute source test directly",
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
      /function mapNativeSymbol\(sym: NativeParsedSymbol\): RustExtractedSymbol[\s\S]*symbolId:\s*sym\.symbolId,[\s\S]*astFingerprint:\s*sym\.astFingerprint,[\s\S]*summary:\s*sym\.summary,[\s\S]*invariantsJson:\s*sym\.invariantsJson,[\s\S]*sideEffectsJson:\s*sym\.sideEffectsJson,[\s\S]*roleTagsJson:\s*typeof sym\.roleTagsJson === "string" \? sym\.roleTagsJson : "\[\]",[\s\S]*searchText:\s*typeof sym\.searchText === "string" \? sym\.searchText : "",/,
      "native symbol mapper should pass through symbol identity and metadata",
    );
  });

  it("uses native Rust symbol IDs/fingerprints and full-file content in Rust pass-1", () => {
    const source = readSource("src/indexer/parser/rust-process-file.ts");

    assert.match(
      source,
      /const filePath = join\(repoRoot, fileMeta\.path\);\s*const content = await readFileAsync\(filePath, "utf-8"\);/,
      "Rust pass-1 should read file content for metadata generation in all files",
    );

    assert.match(
      source,
      /const symbolId = extracted\.symbolId;\s*const astFingerprint = extracted\.astFingerprint;/,
      "Rust pass-1 should use native symbol identity instead of regenerating",
    );
  });

  it("keeps native enrichment metadata compatible across legacy, TS, and sync paths", () => {
    const rustSource = readSource("src/indexer/parser/rust-process-file.ts");
    const tsSource = readSource("src/indexer/parser/process-file.ts");
    const syncTypesSource = readSource("src/sync/types.ts");
    const syncSource = readSource("src/sync/sync.ts");

    assert.match(
      rustSource,
      /const nativeRoleTagsJson = typeof detail\.nativeRoleTagsJson === "string"\s*\?\s*detail\.nativeRoleTagsJson\.trim\(\)\s*:\s*"";/,
      "Rust path should tolerate older native addons that omit enrichment fields",
    );

    assert.match(
      tsSource,
      /roleTagsJson,\s*searchText,\s*updatedAt:/s,
      "TypeScript parsing path should also persist derived search metadata",
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
