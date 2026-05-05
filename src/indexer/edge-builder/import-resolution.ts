import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath } from "../../util/paths.js";
import type { Pass2ImportCache } from "../pass2/types.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { resolveImportCandidatePaths } from "../import-resolution/registry.js";

export async function resolveImportTargets(
  repoId: string,
  repoRoot: string,
  importerRelPath: string,
  imports: ExtractedImport[],
  extensions: string[],
  importerLanguage: string,
  sourceContent?: string,
  /**
   * Optional pass-2 read cache. When provided, replaces the per-import
   * `getFileByRepoPath` and per-target `getSymbolsByFile` round-trips with
   * O(1) map lookups. Pass-1 callers (process-file.ts, rust-process-file.ts)
   * and the live-index draft path leave this undefined and fall back to
   * direct DB reads.
   */
  cache?: Pass2ImportCache,
): Promise<{
  targets: Array<{ symbolId: string; provenance: string }>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
}> {
  const targets: Array<{ symbolId: string; provenance: string }> = [];
  const importedNameToSymbolIds = new Map<string, string[]>();
  const namespaceImports = new Map<string, Map<string, string>>();
  const allImports = sourceContent
    ? [...imports, ...extractCommonJsRequireImports(sourceContent)]
    : imports;

  // Lazily acquired — only the no-cache path needs a read connection. Skipping
  // this when a cache is provided shaves the readPool acquire cost off pass-2
  // resolution, which now does zero DB reads per file when the cache is hot.
  let conn: Awaited<ReturnType<typeof getLadybugConn>> | null = null;
  const getConn = async () => {
    if (!conn) conn = await getLadybugConn();
    return conn;
  };

  for (const imp of allImports) {
    const resolvedPaths = await resolveImportCandidatePaths({
      language: importerLanguage,
      repoRoot,
      importerRelPath,
      specifier: imp.specifier,
      extensions,
    });

    const importedNames = new Set<string>();
    if (imp.defaultImport) importedNames.add(imp.defaultImport);
    for (const name of imp.imports) importedNames.add(name);

    if (importedNames.size === 0) {
      importedNames.add("*");
    }

    if (resolvedPaths.length === 0) {
      for (const name of importedNames) {
        targets.push({
          symbolId: `unresolved:${imp.specifier}:${name}`,
          provenance: `${imp.specifier}:${name}`,
        });
      }
      if (imp.namespaceImport) {
        targets.push({
          symbolId: `unresolved:${imp.specifier}:* as ${imp.namespaceImport}`,
          provenance: `${imp.specifier}:* as ${imp.namespaceImport}`,
        });
      }
      continue;
    }

    const targetFiles: Exclude<
      Awaited<ReturnType<typeof ladybugDb.getFileByRepoPath>>,
      null
    >[] = [];
    for (const relPath of resolvedPaths) {
      const normalizedRelPath = normalizePath(relPath);
      const cached = cache?.fileByRelPath.get(normalizedRelPath);
      if (cached) {
        targetFiles.push(cached);
        continue;
      }
      // Cache miss (or no cache): fall back to a direct point read. For
      // pass-2 with a populated cache this branch only fires for paths
      // outside the repo's tracked file set (e.g. a stale relPath returned
      // by `resolveImportCandidatePaths` after a file was deleted).
      const f = await ladybugDb.getFileByRepoPath(
        await getConn(),
        repoId,
        relPath,
      );
      if (f) targetFiles.push(f);
    }

    if (targetFiles.length === 0) {
      for (const name of importedNames) {
        targets.push({
          symbolId: `unresolved:${resolvedPaths[0]}:${name}`,
          provenance: `${resolvedPaths[0]}:${name}`,
        });
      }
      if (imp.namespaceImport) {
        targets.push({
          symbolId: `unresolved:${resolvedPaths[0]}:* as ${imp.namespaceImport}`,
          provenance: `${resolvedPaths[0]}:* as ${imp.namespaceImport}`,
        });
      }
      continue;
    }

    // ML-D.1: Language-aware import resolution
    // Cross-language imports are resolved when possible
    const sameLanguageFiles = targetFiles.filter(
      (targetFile) => targetFile.language === importerLanguage,
    );
    if (sameLanguageFiles.length === 0) {
      for (const targetFile of targetFiles) {
        for (const name of importedNames) {
          targets.push({
            symbolId: `unresolved:${targetFile.relPath}:${name}`,
            provenance: `cross-language:${targetFile.language}->${importerLanguage}:${name}`,
          });
        }
        if (imp.namespaceImport) {
          targets.push({
            symbolId: `unresolved:${targetFile.relPath}:* as ${imp.namespaceImport}`,
            provenance: `cross-language:${targetFile.language}->${importerLanguage}:* as ${imp.namespaceImport}`,
          });
        }
      }
      continue;
    }

    // When a cache is provided, replace the per-file `getSymbolsByFile`
    // call (which deserializes ~25 properties including JSON blobs) with a
    // map lookup of pre-filtered exported `(symbolId, name)` tuples.
    type ResolvedSymbol = { symbolId: string; name: string };
    const targetSymbols: ResolvedSymbol[] = [];
    for (const targetFile of sameLanguageFiles) {
      if (cache) {
        const cached = cache.exportedSymbolsByFileId.get(targetFile.fileId);
        if (cached) targetSymbols.push(...cached);
        continue;
      }
      const fileSymbols = await ladybugDb.getSymbolsByFile(
        await getConn(),
        targetFile.fileId,
      );
      for (const symbol of fileSymbols) {
        if (symbol.exported) {
          targetSymbols.push({ symbolId: symbol.symbolId, name: symbol.name });
        }
      }
    }

    for (const name of importedNames) {
      if (name.startsWith("*")) {
        targets.push({
          symbolId: `unresolved:${resolvedPaths[0]}:${name}`,
          provenance: `${resolvedPaths[0]}:${name}`,
        });
        continue;
      }

      let match = targetSymbols.find((symbol) => symbol.name === name);
      if (!match && imp.defaultImport === name && targetSymbols.length === 1) {
        match = targetSymbols[0];
      }

      if (match) {
        targets.push({
          symbolId: match.symbolId,
          provenance: `${resolvedPaths[0]}:${name}`,
        });
        const existing = importedNameToSymbolIds.get(name) ?? [];
        existing.push(match.symbolId);
        importedNameToSymbolIds.set(name, existing);
      } else {
        targets.push({
          symbolId: `unresolved:${resolvedPaths[0]}:${name}`,
          provenance: `${resolvedPaths[0]}:${name}`,
        });
      }
    }

    if (imp.namespaceImport) {
      const namespaceMap = new Map<string, string>();
      for (const symbol of targetSymbols) {
        namespaceMap.set(symbol.name, symbol.symbolId);
        targets.push({
          symbolId: symbol.symbolId,
          provenance: `${resolvedPaths[0]}:*`,
        });
      }
      if (namespaceMap.size > 0) {
        namespaceImports.set(imp.namespaceImport, namespaceMap);
      } else {
        targets.push({
          symbolId: `unresolved:${resolvedPaths[0]}:* as ${imp.namespaceImport}`,
          provenance: `${resolvedPaths[0]}:* as ${imp.namespaceImport}`,
        });
      }
    }

    // Handle default imports used as namespace-like dot access
    // e.g., import db from "./queries.js"; db.getRepo()
    // Merge into existing map rather than skipping — two files could
    // use the same default import name (e.g., import db from "./a.js"
    // and import db from "./b.js" in different scopes).
    // Explicit namespace imports (import * as X) take precedence since
    // they capture exact exports, so only add if no namespace import exists.
    //
    // NOTE: This is a heuristic. If the default export is a single value
    // (e.g., `export default class Db { ... }`), mapping all file exports
    // under the default import name is semantically incorrect. The TS
    // adapter's confidence scores (0.92 for namespace lookups) signal
    // this uncertainty to downstream consumers.
    if (imp.defaultImport && !imp.namespaceImport) {
      const existing =
        namespaceImports.get(imp.defaultImport) ?? new Map<string, string>();
      for (const symbol of targetSymbols) {
        // Don't overwrite entries from a prior namespace import
        if (!existing.has(symbol.name)) {
          existing.set(symbol.name, symbol.symbolId);
        }
      }
      if (existing.size > 0) {
        namespaceImports.set(imp.defaultImport, existing);
      }
    }
  }

  return { targets, importedNameToSymbolIds, namespaceImports };
}

function extractCommonJsRequireImports(content: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const seen = new Set<string>();

  const requireNamespaceRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
  const requireDestructureRe =
    /\b(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of content.matchAll(requireNamespaceRe)) {
    const alias = match[1];
    const specifier = match[2];
    if (!alias || !specifier) continue;
    const key = `ns:${alias}:${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isRelative =
      specifier.startsWith("./") || specifier.startsWith("../");
    imports.push({
      specifier,
      isRelative,
      isExternal: !isRelative,
      imports: [],
      namespaceImport: alias,
      isReExport: false,
    });
  }

  for (const match of content.matchAll(requireDestructureRe)) {
    const namesRaw = match[1];
    const specifier = match[2];
    if (!namesRaw || !specifier) continue;
    const names = namesRaw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) return part;
        return part.slice(colonIdx + 1).trim();
      });
    if (names.length === 0) continue;
    const key = `destruct:${names.join(",")}:${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isRelative =
      specifier.startsWith("./") || specifier.startsWith("../");
    imports.push({
      specifier,
      isRelative,
      isExternal: !isRelative,
      imports: names,
      isReExport: false,
    });
  }

  return imports;
}
