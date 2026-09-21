import {
  isClangStyleSymbolScheme,
  mapScipKind,
  parseScipSymbol,
} from "../../scip/kind-mapping.js";
import {
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
} from "../../scip/symbol-matcher.js";
import type { ScipDocument } from "../../scip/types.js";
import { normalizePath } from "../../util/paths.js";
import { VARIABLE_DECLARATION_SCAN_LINE_LIMIT } from "../../util/source-lines.js";

const SOURCE_TEXT_IMPORT_ALIAS_BLOCK_SCAN_LIMIT = 80;
const CPP_CALL_PROOF_LINE_WINDOW_RADIUS = 2;

export function collectNeededSourceLines(
  documents: readonly ScipDocument[],
): Map<string, Set<number>> {
  const neededLinesByPath = new Map<string, Set<number>>();
  for (const document of documents) {
    const relPath = normalizePath(document.relativePath);
    const isCppDocument = isCppLikeScipDocument(document);
    const typescriptVariableSymbols = new Set<string>();
    const typescriptAmbiguousTypeSymbols = new Set<string>();
    if (document.language === "typescript") {
      for (const info of document.symbols) {
        const kind = mapScipKind(info.symbol, info.kind);
        if (!kind.skip && kind.sdlKind === "variable") {
          typescriptVariableSymbols.add(info.symbol);
        } else if (
          !kind.skip &&
          kind.sdlKind === "class" &&
          (info.kind === undefined || info.kind === 0)
        ) {
          typescriptAmbiguousTypeSymbols.add(info.symbol);
        }
      }
    }
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0) {
        if (typescriptVariableSymbols.has(occurrence.symbol)) {
          const lines = neededLinesByPath.get(relPath) ?? new Set<number>();
          for (
            let offset = 0;
            offset < VARIABLE_DECLARATION_SCAN_LINE_LIMIT;
            offset++
          ) {
            lines.add(occurrence.range.startLine + offset);
          }
          neededLinesByPath.set(relPath, lines);
        } else if (typescriptAmbiguousTypeSymbols.has(occurrence.symbol)) {
          const lines = neededLinesByPath.get(relPath) ?? new Set<number>();
          lines.add(occurrence.range.startLine);
          neededLinesByPath.set(relPath, lines);
        }
        continue;
      }
      if ((occurrence.symbolRoles & SCIP_ROLE_IMPORT) !== 0) {
        const lines = neededLinesByPath.get(relPath) ?? new Set<number>();
        // Alias recovery expands only imports that actually contain an alias.
        lines.add(occurrence.range.startLine);
        neededLinesByPath.set(relPath, lines);
        continue;
      }
      if (occurrence.range.startLine !== occurrence.range.endLine) continue;

      const lines = neededLinesByPath.get(relPath) ?? new Set<number>();
      if (isCppDocument || isClangStyleSymbol(occurrence.symbol)) {
        addLineWindow(
          lines,
          occurrence.range.startLine,
          CPP_CALL_PROOF_LINE_WINDOW_RADIUS,
        );
      } else {
        lines.add(occurrence.range.startLine);
      }
      neededLinesByPath.set(relPath, lines);
    }
  }
  return neededLinesByPath;
}

export function selectNeededLines(
  sourceText: string,
  neededLines: ReadonlySet<number>,
): ReadonlyMap<number, string> {
  const sourceLines = sourceText.split(/\r?\n/);
  const selectedLineNumbers = new Set(neededLines);
  // Retain complete bounded Python import statements even without aliases: a
  // from-import may bind a name renamed by an upstream re-export.
  for (let start = 0; start < sourceLines.length; start++) {
    if (!/^[ \t]*from\s+[.\w]+\s+import\s+\(/.test(sourceLines[start]))
      continue;
    let end = start;
    while (
      end <
        Math.min(
          start + SOURCE_TEXT_IMPORT_ALIAS_BLOCK_SCAN_LIMIT - 1,
          sourceLines.length - 1,
        ) &&
      !sourceLines[end].split("#")[0].includes(")")
    )
      end++;
    if (!sourceLines[end].split("#")[0].includes(")")) continue;
    if (
      Array.from({ length: end - start + 1 }, (_, i) => start + i).some((n) =>
        neededLines.has(n),
      )
    ) {
      for (let n = start; n <= end; n++) selectedLineNumbers.add(n);
    }
  }
  // Retain nested from-import suites so proof can see scope exits and writes.
  // This is indexing evidence, not an expansion of agent-facing context.
  for (let start = 0; start < sourceLines.length; start++) {
    const indent = /^([ \t]+)from\s+[.\w]+\s+import\s+/.exec(
      sourceLines[start],
    )?.[1];
    if (!indent || !selectedLineNumbers.has(start)) continue;
    for (let row = start + 1; row < sourceLines.length; row++) {
      selectedLineNumbers.add(row);
      const code = sourceLines[row].split("#")[0];
      if (code.trim() && !sourceLines[row].startsWith(indent)) break;
    }
  }
  for (const lineNumber of neededLines) {
    const line = sourceLines[lineNumber];
    if (!line?.includes(" as ")) continue;
    addLineWindow(
      selectedLineNumbers,
      lineNumber,
      SOURCE_TEXT_IMPORT_ALIAS_BLOCK_SCAN_LIMIT,
    );
  }

  const selected = new Map<number, string>();
  for (const [lineNumber, line] of sourceLines.entries()) {
    if (selectedLineNumbers.has(lineNumber)) {
      selected.set(lineNumber, line);
    }
  }
  return selected;
}

function isCppLikeScipDocument(document: ScipDocument): boolean {
  return /^(c|cc|cpp|c\+\+|cxx|objc|objective-c)$/i.test(document.language);
}

function isClangStyleSymbol(symbol: string): boolean {
  return isClangStyleSymbolScheme(parseScipSymbol(symbol).scheme);
}

function addLineWindow(
  lines: Set<number>,
  lineNumber: number,
  radius: number,
): void {
  const startLine = Math.max(0, lineNumber - radius);
  const endLine = lineNumber + radius;
  for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
    lines.add(currentLine);
  }
}
