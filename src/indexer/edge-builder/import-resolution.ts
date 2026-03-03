import { dirname, join, resolve } from "path";

import { getFileByRepoPath, getSymbolsByFileLite } from "../../db/queries.js";
import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";

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

  for (const imp of allImports) {
    const resolvedPath = await resolveImportToPath(
      repoRoot,
      importerRelPath,
      imp.specifier,
      extensions,
    );

    const importedNames = new Set<string>();
    if (imp.defaultImport) importedNames.add(imp.defaultImport);
    for (const name of imp.imports) importedNames.add(name);

    if (importedNames.size === 0) {
      importedNames.add("*");
    }

    if (!resolvedPath) {
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

    const targetFile = getFileByRepoPath(repoId, resolvedPath);
    if (!targetFile) {
      for (const name of importedNames) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `${resolvedPath}:${name}`,
        });
      }
      if (imp.namespaceImport) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:* as ${imp.namespaceImport}`,
          provenance: `${resolvedPath}:* as ${imp.namespaceImport}`,
        });
      }
      continue;
    }

    // ML-D.1: Language-aware import resolution
    // Cross-language imports are resolved when possible
    if (targetFile.language !== importerLanguage) {
      for (const name of importedNames) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `cross-language:${targetFile.language}->${importerLanguage}:${name}`,
        });
      }
      if (imp.namespaceImport) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:* as ${imp.namespaceImport}`,
          provenance: `cross-language:${targetFile.language}->${importerLanguage}:* as ${imp.namespaceImport}`,
        });
      }
    }

    const targetSymbols = getSymbolsByFileLite(targetFile.file_id).filter(
      (symbol) => symbol.exported === 1,
    );

    for (const name of importedNames) {
      if (name.startsWith("*")) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `${resolvedPath}:${name}`,
        });
        continue;
      }

      let match = targetSymbols.find((symbol) => symbol.name === name);
      if (!match && imp.defaultImport === name && targetSymbols.length === 1) {
        match = targetSymbols[0];
      }

      if (match) {
        targets.push({
          symbolId: match.symbol_id,
          provenance: `${resolvedPath}:${name}`,
        });
        const existing = importedNameToSymbolIds.get(name) ?? [];
        existing.push(match.symbol_id);
        importedNameToSymbolIds.set(name, existing);
      } else {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `${resolvedPath}:${name}`,
        });
      }
    }

    if (imp.namespaceImport) {
      const namespaceMap = new Map<string, string>();
      for (const symbol of targetSymbols) {
        namespaceMap.set(symbol.name, symbol.symbol_id);
        targets.push({
          symbolId: symbol.symbol_id,
          provenance: `${resolvedPath}:*`,
        });
      }
      if (namespaceMap.size > 0) {
        namespaceImports.set(imp.namespaceImport, namespaceMap);
      } else {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:* as ${imp.namespaceImport}`,
          provenance: `${resolvedPath}:* as ${imp.namespaceImport}`,
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

async function resolveImportToPath(
  repoRoot: string,
  importerRelPath: string,
  specifier: string,
  extensions: string[],
): Promise<string | null> {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }

  const importerDir = dirname(importerRelPath);
  const baseRelPath = normalizePath(join(importerDir, specifier));
  const baseAbsPath = resolve(repoRoot, baseRelPath);

  const hasExtension = extensions.some((ext) => baseRelPath.endsWith(ext));
  const candidates: string[] = [];

  if (hasExtension) {
    candidates.push(baseRelPath);
  } else {
    for (const ext of extensions) {
      candidates.push(`${baseRelPath}${ext}`);
    }
    for (const ext of extensions) {
      candidates.push(normalizePath(join(baseRelPath, `index${ext}`)));
    }
  }

  for (const relPath of candidates) {
    const absPath = resolve(repoRoot, relPath);
    if (await existsAsync(absPath)) {
      return normalizePath(relPath);
    }
  }

  if (hasExtension && (await existsAsync(baseAbsPath))) {
    return normalizePath(baseRelPath);
  }

  return null;
}

