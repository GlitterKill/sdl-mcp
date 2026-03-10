import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
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

  const conn = await getLadybugConn();

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

    const targetFiles = (
      await Promise.all(
        resolvedPaths.map((relPath) => ladybugDb.getFileByRepoPath(conn, repoId, relPath)),
      )
    ).flatMap((targetFile) => (targetFile ? [targetFile] : []));

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

    const targetSymbols = (
      await Promise.all(
        sameLanguageFiles.map((targetFile) =>
          ladybugDb.getSymbolsByFile(conn, targetFile.fileId),
        ),
      )
    )
      .flat()
      .filter((symbol) => symbol.exported);

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
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
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
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
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
