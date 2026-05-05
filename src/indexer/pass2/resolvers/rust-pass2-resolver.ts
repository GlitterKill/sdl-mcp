import { join } from "path";

import type { SyntaxNode, Tree } from "tree-sitter";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../domain/types.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { singleFlight } from "../../../util/concurrency.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import type { FileMetadata } from "../../fileScanner.js";
import { isBuiltinCall } from "../../edge-builder/builtins.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/enclosing-symbol.js";
import {
  bucketForResolution,
  recordPass2ResolverEdge,
  recordPass2ResolverUnresolved,
} from "../../edge-builder/telemetry.js";
import {
  followBarrelChain,
  hooksFromMap,
  type ReExport,
} from "../barrel-walker.js";
import { confidenceFor } from "../confidence.js";
import { findEnclosingByType } from "../scope-walker.js";
import type { ScopeNode } from "../scope-walker.js";

import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";

type ExtractedSymbol = {
  nodeId: string;
  kind: SymbolKind;
  name: string;
  exported: boolean;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
};

type ExtractedCall = {
  callerNodeId?: string;
  calleeIdentifier: string;
  isResolved: boolean;
  callType: "function" | "method" | "constructor" | "dynamic";
  calleeSymbolId?: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
};

type FilteredSymbolDetail = {
  extractedSymbol: ExtractedSymbol;
  symbolId: string;
};

type RustResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type RustModuleIndex = {
  modulePathByFilePath: Map<string, string>;
  symbolsByModulePath: Map<string, Array<SymbolRow & { relPath: string }>>;
};

const RUST_PASS2_EXTENSIONS = new Set([".rs"]);

/**
 * Legacy literal confidence values that do not map cleanly to a single
 * `CallResolutionStrategy` in the shared rubric (Phase 2 Task 2.0.1).
 * These are kept behind named constants so the byte-for-byte snapshot
 * is preserved until Task 2.11.2 retires the legacy path. Once the new
 * rubric is the single source of truth, the same-file/disambiguated/
 * global-fallback paths should migrate to their canonical strategies
 * (compiler-resolved, cross-file-name-ambiguous, global-fallback).
 */
const RUST_SAME_FILE_ALREADY_BOUND_CONFIDENCE = 0.93;
const RUST_GLOBAL_FALLBACK_CONFIDENCE = 0.45;

function toFullKey(
  kind: SymbolKind,
  name: string,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
}

function toStartKey(
  kind: SymbolKind,
  name: string,
  range: { startLine: number; startCol: number },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}`;
}

function toStartLineKey(
  kind: SymbolKind,
  name: string,
  range: { startLine: number },
): string {
  return `${kind}:${name}:${range.startLine}`;
}

function callRangeKey(range: {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}): string {
  return `${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
}

function toNameKindKey(kind: SymbolKind, name: string): string {
  return `${kind}:${name}`;
}

function pushSymbol(
  map: Map<string, SymbolRow[]>,
  key: string,
  symbol: SymbolRow,
): void {
  const existing = map.get(key) ?? [];
  existing.push(symbol);
  map.set(key, existing);
}

function mapExtractedSymbolsToExisting(
  filePath: string,
  extractedSymbols: ExtractedSymbol[],
  existingSymbols: SymbolRow[],
  telemetry?: Pass2ResolverContext["telemetry"],
): FilteredSymbolDetail[] {
  const symbolIdByFullKey = new Map<string, string>();
  const symbolsByStartKey = new Map<string, SymbolRow[]>();
  const symbolsByStartLineKey = new Map<string, SymbolRow[]>();
  const symbolsByNameKindKey = new Map<string, SymbolRow[]>();

  for (const symbol of existingSymbols) {
    const range = {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    };
    symbolIdByFullKey.set(
      toFullKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol.symbolId,
    );
    pushSymbol(
      symbolsByStartKey,
      toStartKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByStartLineKey,
      toStartLineKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByNameKindKey,
      toNameKindKey(symbol.kind as SymbolKind, symbol.name),
      symbol,
    );
  }

  const filteredSymbolDetails = extractedSymbols
    .map((extractedSymbol) => {
      const fullMatch = symbolIdByFullKey.get(
        toFullKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (fullMatch) {
        return { extractedSymbol, symbolId: fullMatch };
      }

      const startCandidates = symbolsByStartKey.get(
        toStartKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startCandidates && startCandidates.length === 1) {
        return { extractedSymbol, symbolId: startCandidates[0].symbolId };
      }

      const startLineCandidates = symbolsByStartLineKey.get(
        toStartLineKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startLineCandidates && startLineCandidates.length === 1) {
        return { extractedSymbol, symbolId: startLineCandidates[0].symbolId };
      }

      const nameKindCandidates = symbolsByNameKindKey.get(
        toNameKindKey(extractedSymbol.kind, extractedSymbol.name),
      );
      if (nameKindCandidates && nameKindCandidates.length === 1) {
        return { extractedSymbol, symbolId: nameKindCandidates[0].symbolId };
      }

      return null;
    })
    .filter((detail): detail is FilteredSymbolDetail => Boolean(detail));

  if (telemetry && filteredSymbolDetails.length === 0) {
    telemetry.pass2FilesNoMappedSymbols++;
    telemetry.samples.noMappedSymbols.push(filePath);
  }

  return filteredSymbolDetails;
}

/**
 * In-memory cleanup of stale dedup keys for the symbols this file is about to
 * re-resolve. The matching SQL DELETE is deferred to `submitEdgeWrite` so the
 * dispatcher can combine deletes + inserts across an entire concurrency batch
 * into a single `withWriteConn`.
 */
function clearLocalCallDedupKeys(
  symbolIds: string[],
  createdCallEdges: Set<string>,
): void {
  if (symbolIds.length === 0) return;
  for (const symbolId of symbolIds) {
    for (const edgeKey of Array.from(createdCallEdges)) {
      if (edgeKey.startsWith(`${symbolId}->`)) {
        createdCallEdges.delete(edgeKey);
      }
    }
  }
}

function createNodeIdToSymbolId(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string> {
  const nodeIdToSymbolId = new Map<string, string>();
  for (const detail of filteredSymbolDetails) {
    nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
  }
  return nodeIdToSymbolId;
}

function normalizeRustTypeName(typeName: string | undefined): string {
  if (!typeName) {
    return "";
  }
  return (
    typeName
      .trim()
      .replace(/^&(?:mut\s+)?/, "")
      .replace(/^crate::/, "")
      .split("::")
      .pop()
      ?.trim() ?? ""
  );
}

function inferRustModulePath(relPath: string): string {
  const normalized = normalizePath(relPath);
  const srcPrefix = "src/";
  const withinSrc = normalized.startsWith(srcPrefix)
    ? normalized.slice(srcPrefix.length)
    : normalized;

  if (withinSrc === "lib.rs" || withinSrc === "main.rs") {
    return "crate";
  }

  if (withinSrc.endsWith("/mod.rs")) {
    const moduleSegments = withinSrc
      .slice(0, -"/mod.rs".length)
      .split("/")
      .filter(Boolean);
    return moduleSegments.length > 0
      ? `crate::${moduleSegments.join("::")}`
      : "crate";
  }

  if (withinSrc.endsWith(".rs")) {
    const moduleSegments = withinSrc
      .slice(0, -".rs".length)
      .split("/")
      .filter(Boolean);
    return moduleSegments.length > 0
      ? `crate::${moduleSegments.join("::")}`
      : "crate";
  }

  return "crate";
}

async function buildRustModuleIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<RustModuleIndex> {
  return singleFlight(cache, `pass2-rust:module-index:${repoId}`, async () => {
    const conn = await getLadybugConn();
    const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
    const rustFiles = repoFiles.filter((file) => file.language === "rust");
    const rustFileIds = new Set(rustFiles.map((file) => file.fileId));
    const fileById = new Map(rustFiles.map((file) => [file.fileId, file]));
    const modulePathByFilePath = new Map<string, string>();
    const symbolsByModulePath = new Map<
      string,
      Array<SymbolRow & { relPath: string }>
    >();

    for (const file of rustFiles) {
      modulePathByFilePath.set(file.relPath, inferRustModulePath(file.relPath));
    }

    const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
    for (const symbol of repoSymbols) {
      if (!rustFileIds.has(symbol.fileId)) {
        continue;
      }
      const file = fileById.get(symbol.fileId);
      if (!file) {
        continue;
      }
      const modulePath = modulePathByFilePath.get(file.relPath);
      if (!modulePath) {
        continue;
      }
      const bucket = symbolsByModulePath.get(modulePath) ?? [];
      bucket.push({
        ...symbol,
        relPath: file.relPath,
      });
      symbolsByModulePath.set(modulePath, bucket);
    }

    return {
      modulePathByFilePath,
      symbolsByModulePath,
    };
  });
}

function buildSameModuleFunctionIndex(
  currentFilePath: string,
  sameModuleSymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const sameModuleNameToSymbolIds = new Map<string, string[]>();
  for (const symbol of sameModuleSymbols) {
    if (symbol.relPath === currentFilePath) {
      continue;
    }
    if (symbol.kind !== "function") {
      continue;
    }
    const existing = sameModuleNameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    sameModuleNameToSymbolIds.set(symbol.name, existing);
  }
  return sameModuleNameToSymbolIds;
}

function buildCratePathFunctionIndex(
  symbolsByModulePath: RustModuleIndex["symbolsByModulePath"],
): Map<string, string[]> {
  const byCratePath = new Map<string, string[]>();

  for (const [modulePath, symbols] of symbolsByModulePath) {
    for (const symbol of symbols) {
      if (symbol.kind !== "function") {
        continue;
      }
      const key = `${modulePath}::${symbol.name}`;
      const existing = byCratePath.get(key) ?? [];
      existing.push(symbol.symbolId);
      byCratePath.set(key, existing);
    }
  }

  return byCratePath;
}

function parseOwnerTypeFromNodeId(nodeId: string): string | null {
  if (!nodeId.includes("::")) {
    return null;
  }
  const parts = nodeId.split("::");
  if (parts.length < 2) {
    return null;
  }
  return normalizeRustTypeName(parts[0]) || null;
}

function buildLocalImplMethodNamespaces(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, Map<string, string>> {
  const methodsByType = new Map<string, Map<string, string>>();

  for (const detail of filteredSymbolDetails) {
    if (detail.extractedSymbol.kind !== "method") {
      continue;
    }
    const ownerType = parseOwnerTypeFromNodeId(detail.extractedSymbol.nodeId);
    if (!ownerType) {
      continue;
    }

    const methodBucket =
      methodsByType.get(ownerType) ?? new Map<string, string>();
    methodBucket.set(detail.extractedSymbol.name, detail.symbolId);
    methodsByType.set(ownerType, methodBucket);
  }

  return methodsByType;
}

function inferRustReceiverTypes(tree: Tree): Map<string, string> {
  const receiverTypes = new Map<string, string>();

  const visit = (node: SyntaxNode): void => {
    if (node.type === "let_declaration") {
      const text = node.text;

      const explicitType = text.match(
        /^let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_:]*)/,
      );
      if (explicitType?.[1] && explicitType?.[2]) {
        receiverTypes.set(
          explicitType[1],
          normalizeRustTypeName(explicitType[2]),
        );
      }

      const constructorType = text.match(
        /^let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_:]*)::[A-Za-z_][A-Za-z0-9_]*\s*\(/,
      );
      if (constructorType?.[1] && constructorType?.[2]) {
        receiverTypes.set(
          constructorType[1],
          normalizeRustTypeName(constructorType[2]),
        );
      }

      const structLiteralType = text.match(
        /^let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_:]*)\s*\{/,
      );
      if (structLiteralType?.[1] && structLiteralType?.[2]) {
        receiverTypes.set(
          structLiteralType[1],
          normalizeRustTypeName(structLiteralType[2]),
        );
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return receiverTypes;
}

function buildReceiverNamespaces(
  receiverTypes: Map<string, string>,
  methodsByType: Map<string, Map<string, string>>,
): Map<string, Map<string, string>> {
  const receiverNamespaces = new Map<string, Map<string, string>>();

  for (const [variable, receiverType] of receiverTypes) {
    const methods = methodsByType.get(normalizeRustTypeName(receiverType));
    if (methods) {
      receiverNamespaces.set(variable, methods);
    }
  }

  return receiverNamespaces;
}

function mergeImportedNameMaps(
  primary: Map<string, string[]>,
  secondary: Map<string, string[]>,
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const [name, ids] of primary) {
    merged.set(name, [...ids]);
  }
  for (const [name, ids] of secondary) {
    const existing = merged.get(name) ?? [];
    for (const id of ids) {
      if (!existing.includes(id)) {
        existing.push(id);
      }
    }
    merged.set(name, existing);
  }
  return merged;
}

function toUniqueCandidates(candidates: string[] | undefined): string[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }
  return Array.from(new Set(candidates));
}

function buildCratePathCandidates(identifier: string): string[] {
  if (!identifier.startsWith("crate::")) {
    return [];
  }

  const compact = identifier.trim().replace(/\s+/g, "");
  const parts = compact.split("::").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "crate") {
    return [];
  }

  const targetName = parts[parts.length - 1];
  const modulePath = parts.slice(0, -1).join("::");
  if (!targetName || !modulePath) {
    return [];
  }

  return [`${modulePath}::${targetName}`];
}

function collectExplicitImportedNames(
  imports: Array<{ imports: string[] }>,
): Set<string> {
  const names = new Set<string>();
  for (const imp of imports) {
    for (const importedName of imp.imports) {
      if (importedName && importedName !== "*") {
        names.add(importedName);
      }
    }
  }
  return names;
}

// Well-known external crate prefixes that supplement the dynamic set built
// from each file's `use` imports. Only truly universal crates belong here;
// the dynamic set (externalCratePrefixes) built from each file's `use`
// imports is the primary mechanism and handles ecosystem-specific crates.
const KNOWN_EXTERNAL_CRATE_PREFIXES = new Set(["std", "core", "alloc"]);

function isExternalCrateCall(
  calleeId: string,
  externalCratePrefixes: Set<string>,
): boolean {
  if (!calleeId.includes("::")) return false;
  const prefix = calleeId.split("::")[0];
  if (externalCratePrefixes.has(prefix)) return true;
  return KNOWN_EXTERNAL_CRATE_PREFIXES.has(prefix);
}

function disambiguateRustCandidates(
  candidates: string[],
  callerFilePath: string,
  symbolIdDetails: Map<string, { filePath: string; exported: boolean }>,
): string | null {
  if (candidates.length <= 1) return candidates[0] ?? null;

  // 1. Prefer symbols in the same Rust module subtree
  const callerModule = inferRustModulePath(callerFilePath);
  const parentModule = callerModule.split("::").slice(0, -1).join("::");
  if (parentModule) {
    const sameModule = candidates.filter((id) => {
      const detail = symbolIdDetails.get(id);
      return (
        detail && inferRustModulePath(detail.filePath).startsWith(parentModule)
      );
    });
    if (sameModule.length === 1) return sameModule[0];
  }

  // 2. Prefer exported (pub) symbols over private
  const exported = candidates.filter((id) => {
    const detail = symbolIdDetails.get(id);
    return detail?.exported;
  });
  if (exported.length === 1) return exported[0];

  // 3. Prefer non-test symbols over test symbols
  const nonTest = candidates.filter((id) => {
    const detail = symbolIdDetails.get(id);
    return (
      detail &&
      !detail.filePath.includes("/tests/") &&
      !detail.filePath.endsWith("_test.rs") &&
      !detail.filePath.endsWith(".test.rs")
    );
  });
  if (nonTest.length === 1) return nonTest[0];

  return null; // Still ambiguous
}

// ============================================================================
// Phase 2 Task 2.4.x — trait default dispatch + Self::method + aliased `use`
// ============================================================================

/**
 * Minimal ScopeNode view produced from a tree-sitter node subtree. Keeps
 * the `findEnclosingByType` helper in `scope-walker.ts` decoupled from
 * tree-sitter. We only materialise a shallow projection: `type`,
 * positions, children, and `text`.
 */
function toScopeNode(node: SyntaxNode): ScopeNode {
  const children: ScopeNode[] = node.children.map((c) => toScopeNode(c));
  return {
    type: node.type,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
    children,
    text: node.text,
  };
}

/**
 * Phase 2 Task 2.4.3 — returns the type name of the enclosing `impl`
 * block at the given position, or null when the position is not inside
 * any `impl`. Used to resolve `Self::method` calls to the local impl's
 * method table.
 */
function findEnclosingImplType(
  tree: Tree,
  line: number,
  col: number,
): string | null {
  const root = toScopeNode(tree.rootNode);
  const impl = findEnclosingByType(root, line, col, "impl_item");
  if (!impl) return null;
  // `impl_item` children contain the type node directly — walk its
  // children to find the first `type_identifier` or `generic_type`
  // (matching the adapter's `extractImplInfo` logic).
  for (const child of impl.children) {
    if (child.type === "type_identifier") {
      return normalizeRustTypeName(child.text);
    }
    if (child.type === "generic_type") {
      for (const grand of child.children) {
        if (grand.type === "type_identifier") {
          return normalizeRustTypeName(grand.text);
        }
      }
    }
  }
  return null;
}

/**
 * Phase 2 Task 2.4.1 — builds the trait-default method map for a file.
 *
 * Scans `trait_item` nodes for method declarations that include a body
 * (`fn name(&self) { ... }`) and records the trait's own symbolId for
 * each such method. Then scans `impl_item` nodes with a `trait` field
 * (i.e. `impl Trait for Type`) to build a Type -> Trait mapping. When a
 * method call's receiver type does not define the method locally but
 * the receiver implements a trait whose default defines it, the call
 * resolves to the trait's symbol.
 */
type TraitDefaultMap = {
  /** traitName -> methodName -> symbolId of the trait's default fn */
  traitDefaultMethods: Map<string, Map<string, string>>;
  /** typeName -> list of trait names that the type implements */
  implementedTraitsByType: Map<string, string[]>;
};

function buildRustTraitDefaultMap(
  tree: Tree,
  filteredSymbolDetails: FilteredSymbolDetail[],
): TraitDefaultMap {
  const traitDefaultMethods = new Map<string, Map<string, string>>();
  const implementedTraitsByType = new Map<string, string[]>();

  // Index extracted method symbols by nodeId (TypeOrTrait::method) for
  // quick lookup once we know which trait owns which default method.
  const symbolByNodeId = new Map<string, string>();
  for (const d of filteredSymbolDetails) {
    symbolByNodeId.set(d.extractedSymbol.nodeId, d.symbolId);
  }

  const visit = (node: SyntaxNode): void => {
    if (node.type === "trait_item") {
      const nameNode = node.childForFieldName("name");
      const bodyNode = node.childForFieldName("body");
      if (nameNode && bodyNode) {
        const traitName = normalizeRustTypeName(nameNode.text);
        const methodMap =
          traitDefaultMethods.get(traitName) ?? new Map<string, string>();
        for (const child of bodyNode.children) {
          if (child.type !== "function_item") continue;
          // Trait fns without a body are abstract; only keep ones that
          // have a `body` child block.
          const fnBody = child.childForFieldName("body");
          if (!fnBody) continue;
          const fnNameNode = child.childForFieldName("name");
          if (!fnNameNode) continue;
          const methodName = fnNameNode.text;
          // Prefer the explicit extracted method symbolId if the adapter
          // recorded one under `Trait::method`; otherwise fall back to a
          // synthetic node id so downstream callers can still form an
          // edge key.
          const nodeId = `${traitName}::${methodName}`;
          const symbolId = symbolByNodeId.get(nodeId);
          if (symbolId) {
            methodMap.set(methodName, symbolId);
          }
        }
        if (methodMap.size > 0) {
          traitDefaultMethods.set(traitName, methodMap);
        }
      }
    } else if (node.type === "impl_item") {
      // Only `impl Trait for Type` has a `trait` field; `impl Type` does
      // not. tree-sitter-rust exposes both via `childForFieldName`.
      const traitNode = node.childForFieldName("trait");
      const typeNode = node.childForFieldName("type");
      if (traitNode && typeNode) {
        const traitName = normalizeRustTypeName(traitNode.text);
        const typeName = normalizeRustTypeName(typeNode.text);
        if (traitName && typeName) {
          const existing = implementedTraitsByType.get(typeName) ?? [];
          if (!existing.includes(traitName)) existing.push(traitName);
          implementedTraitsByType.set(typeName, existing);
        }
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return { traitDefaultMethods, implementedTraitsByType };
}

/**
 * Phase 2 Task 2.4.1 — resolves `receiverType.method` to a trait's
 * default implementation when the receiver type doesn't define the
 * method locally. Returns the trait's method symbolId or null.
 */
function resolveTraitDefaultMethod(
  receiverType: string,
  methodName: string,
  localImplMethodsByType: Map<string, Map<string, string>>,
  traitDefaults: TraitDefaultMap,
): string | null {
  const normalized = normalizeRustTypeName(receiverType);
  const localMethods = localImplMethodsByType.get(normalized);
  if (localMethods?.has(methodName)) {
    // Local override wins over the trait default.
    return null;
  }
  const traits = traitDefaults.implementedTraitsByType.get(normalized) ?? [];
  for (const traitName of traits) {
    const methodMap = traitDefaults.traitDefaultMethods.get(traitName);
    const hit = methodMap?.get(methodName);
    if (hit) return hit;
  }
  return null;
}

/**
 * Phase 2 Task 2.4.2 — grouped and aliased `use` resolution.
 *
 * Parses the file's `use` declarations and returns a map from the local
 * alias name to the underlying source name (what the target file
 * actually exports). Callers can use this to translate a call's
 * identifier back to its source name before looking it up in the
 * regular `importedNameToSymbolIds` map.
 */
function buildRustUseAliasMap(source: string): Map<string, string> {
  const aliasToSource = new Map<string, string>();
  const bindings = parseRustUseDeclarations(source);
  for (const b of bindings) {
    if (b.isWildcard) continue;
    if (b.localName === b.sourceName) continue;
    aliasToSource.set(b.localName, b.sourceName);
  }
  return aliasToSource;
}

/**
 * Phase 2 Task 2.4.2 — returns `ReExport` records for every `pub use`
 * binding in the file. Used to drive the shared barrel walker when
 * tracing re-export chains across modules.
 */
function buildRustReExportsForFile(source: string): ReExport[] {
  const bindings = parseRustUseDeclarations(source);
  const reExports: ReExport[] = [];
  for (const b of bindings) {
    if (!b.isReExport || b.isWildcard) continue;
    // The target file is expressed as a Rust module specifier; the
    // walker is path-keyed, so callers are expected to resolve
    // specifiers themselves before feeding them to `followBarrelChain`.
    reExports.push({
      exportedName: b.localName,
      targetFile: b.specifier,
      targetName: b.sourceName,
    });
  }
  return reExports;
}

/**
 * Phase 2 Task 2.4.2 — follows a `pub use` chain starting from `startFile`
 * to locate the real definition of `symbolName`. The walker is bounded
 * by `MAX_BARREL_DEPTH` and returns the final file/name pair or null.
 */
function followRustBarrelChain(
  symbolName: string,
  startFile: string,
  reExportsByFile: Map<string, readonly ReExport[]>,
): { resolvedFile: string; resolvedName: string } | null {
  const hooks = hooksFromMap(reExportsByFile);
  const walked = followBarrelChain(symbolName, startFile, hooks);
  if (!walked) return null;
  return {
    resolvedFile: walked.resolvedFile,
    resolvedName: walked.resolvedName,
  };
}

function resolveRustPass2CallTarget(params: {
  call: ExtractedCall;
  callerSymbol: ExtractedSymbol;
  nodeIdToSymbolId: Map<string, string>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  localImplMethodsByType: Map<string, Map<string, string>>;
  receiverNamespaces: Map<string, Map<string, string>>;
  explicitImportedNames: Set<string>;
  sameModuleNameToSymbolIds: Map<string, string[]>;
  cratePathToSymbolIds: Map<string, string[]>;
  globalNameToSymbolIds?: Map<string, string[]>;
  callerFilePath?: string;
  symbolIdDetails?: Map<string, { filePath: string; exported: boolean }>;
  // Phase 2 Task 2.4.x additions.
  aliasToSourceName?: Map<string, string>;
  traitDefaults?: TraitDefaultMap;
  selfImplType?: string | null;
  receiverTypes?: Map<string, string>;
}): RustResolvedCall | null {
  const {
    call,
    callerSymbol,
    nodeIdToSymbolId,
    importedNameToSymbolIds,
    namespaceImports,
    localImplMethodsByType,
    receiverNamespaces,
    explicitImportedNames,
    sameModuleNameToSymbolIds,
    cratePathToSymbolIds,
    globalNameToSymbolIds,
    callerFilePath,
    symbolIdDetails,
    aliasToSourceName,
    traitDefaults,
    selfImplType,
    receiverTypes,
  } = params;

  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return {
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      confidence: RUST_SAME_FILE_ALREADY_BOUND_CONFIDENCE,
      resolution: "same-file",
    };
  }

  const identifier = call.calleeIdentifier
    .replace(/^new\s+/, "")
    .replace(/!$/, "")
    .trim();
  if (!identifier) {
    return null;
  }

  const globalCandidates = toUniqueCandidates(
    globalNameToSymbolIds?.get(identifier),
  );

  const directImportedCandidates = toUniqueCandidates(
    importedNameToSymbolIds.get(identifier),
  );
  if (directImportedCandidates.length === 1) {
    return {
      symbolId: directImportedCandidates[0],
      isResolved: true,
      confidence: confidenceFor("import-direct"),
      resolution: "use-import",
    };
  }

  // Phase 2 Task 2.4.2 — aliased `use` (`use foo::bar as renamed`).
  // Translate the local alias back to its source name and retry.
  const aliasedSourceName = aliasToSourceName?.get(identifier);
  if (aliasedSourceName) {
    const aliasedCandidates = toUniqueCandidates(
      importedNameToSymbolIds.get(aliasedSourceName),
    );
    if (aliasedCandidates.length === 1) {
      return {
        symbolId: aliasedCandidates[0],
        isResolved: true,
        confidence: confidenceFor("import-aliased"),
        resolution: "use-import-aliased",
      };
    }
  }

  if (identifier.includes("::")) {
    const parts = identifier.split("::");
    const prefix = parts[0];
    const member = parts[parts.length - 1];
    const lastNameImportedCandidates = toUniqueCandidates(
      importedNameToSymbolIds.get(member),
    );

    const namespace = namespaceImports.get(prefix);
    if (namespace?.has(member)) {
      return {
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        confidence: confidenceFor("import-direct"),
        resolution: "use-import",
      };
    }

    if (
      prefix !== "crate" &&
      prefix !== "self" &&
      prefix !== "super" &&
      lastNameImportedCandidates.length === 1
    ) {
      return {
        symbolId: lastNameImportedCandidates[0],
        isResolved: true,
        confidence: confidenceFor("import-direct"),
        resolution: "use-import",
      };
    }
  }

  if (explicitImportedNames.has(identifier) && globalCandidates.length === 1) {
    return {
      symbolId: globalCandidates[0],
      isResolved: true,
      confidence: confidenceFor("import-direct"),
      resolution: "use-import",
    };
  }

  if (identifier.includes("::")) {
    const parts = identifier.split("::").filter(Boolean);
    // Phase 2 Task 2.4.3 — `Self::method` resolves to the enclosing impl.
    if (parts.length >= 2 && parts[0] === "Self" && selfImplType) {
      const methodName = parts[parts.length - 1];
      const methodBucket = localImplMethodsByType.get(selfImplType);
      if (methodBucket?.has(methodName)) {
        return {
          symbolId: methodBucket.get(methodName) ?? null,
          isResolved: true,
          confidence: confidenceFor("same-file-lexical"),
          resolution: "self-impl-method",
        };
      }
    }
    if (parts.length >= 2) {
      const ownerType = normalizeRustTypeName(parts[parts.length - 2]);
      const methodName = parts[parts.length - 1];
      const methodBucket = localImplMethodsByType.get(ownerType);
      if (methodBucket?.has(methodName)) {
        return {
          symbolId: methodBucket.get(methodName) ?? null,
          isResolved: true,
          confidence: confidenceFor("same-file-lexical"),
          resolution: "impl-method",
        };
      }
      // Phase 2 Task 2.4.1 — fall back to trait default method.
      if (traitDefaults) {
        const traitHit = resolveTraitDefaultMethod(
          ownerType,
          methodName,
          localImplMethodsByType,
          traitDefaults,
        );
        if (traitHit) {
          return {
            symbolId: traitHit,
            isResolved: true,
            confidence: confidenceFor("trait-default"),
            resolution: "trait-default",
          };
        }
      }
    }
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const receiver = parts[0];
    const methodName = parts[parts.length - 1];

    if (receiver === "self") {
      const ownerType = parseOwnerTypeFromNodeId(callerSymbol.nodeId);
      if (ownerType) {
        const methodBucket = localImplMethodsByType.get(ownerType);
        if (methodBucket?.has(methodName)) {
          return {
            symbolId: methodBucket.get(methodName) ?? null,
            isResolved: true,
            confidence: confidenceFor("same-file-lexical"),
            resolution: "impl-method",
          };
        }
      }
    }

    const receiverNamespace = receiverNamespaces.get(receiver);
    if (receiverNamespace?.has(methodName)) {
      return {
        symbolId: receiverNamespace.get(methodName) ?? null,
        isResolved: true,
        confidence: confidenceFor("same-file-lexical"),
        resolution: "impl-method",
      };
    }

    // Phase 2 Task 2.4.1 — trait-default dispatch for receiver.method()
    // when the receiver's type has no local override of the method.
    if (traitDefaults) {
      const receiverType =
        receiver === "self"
          ? (selfImplType ?? parseOwnerTypeFromNodeId(callerSymbol.nodeId))
          : receiverTypes?.get(receiver);
      if (receiverType) {
        const traitHit = resolveTraitDefaultMethod(
          receiverType,
          methodName,
          localImplMethodsByType,
          traitDefaults,
        );
        if (traitHit) {
          return {
            symbolId: traitHit,
            isResolved: true,
            confidence: confidenceFor("trait-default"),
            resolution: "trait-default",
          };
        }
      }
    }
  }

  if (identifier.startsWith("crate::")) {
    const candidates = buildCratePathCandidates(identifier).flatMap(
      (candidate) => cratePathToSymbolIds.get(candidate) ?? [],
    );
    if (candidates.length === 1) {
      return {
        symbolId: candidates[0],
        isResolved: true,
        confidence: confidenceFor("module-qualified"),
        resolution: "crate-path",
      };
    }
  }

  const sameModuleCandidates = toUniqueCandidates(
    sameModuleNameToSymbolIds.get(identifier),
  );
  if (sameModuleCandidates.length === 1) {
    return {
      symbolId: sameModuleCandidates[0],
      isResolved: true,
      confidence: confidenceFor("header-pair"),
      resolution: "same-module",
    };
  }

  if (globalCandidates.length === 1) {
    return {
      symbolId: globalCandidates[0],
      isResolved: true,
      confidence: RUST_GLOBAL_FALLBACK_CONFIDENCE,
      resolution: "global-fallback",
    };
  }

  // Attempt disambiguation when multiple candidates exist
  const allCandidates = toUniqueCandidates([
    ...directImportedCandidates,
    ...sameModuleCandidates,
    ...globalCandidates,
  ]);
  if (allCandidates.length > 1 && callerFilePath && symbolIdDetails) {
    const disambiguated = disambiguateRustCandidates(
      allCandidates,
      callerFilePath,
      symbolIdDetails,
    );
    if (disambiguated) {
      return {
        symbolId: disambiguated,
        isResolved: true,
        confidence: confidenceFor("disambiguated"),
        resolution: "disambiguated",
      };
    }
  }

  return {
    symbolId: null,
    isResolved: false,
    confidence: confidenceFor("heuristic-only"),
    resolution: "unresolved",
    targetName: identifier,
    candidateCount:
      directImportedCandidates.length +
      sameModuleCandidates.length +
      globalCandidates.length,
  };
}

async function resolveRustCallEdgesPass2(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  telemetry?: Pass2ResolverContext["telemetry"];
  cache?: Map<string, unknown>;
  mode?: "full" | "incremental";
  submitEdgeWrite?: Pass2ResolverContext["submitEdgeWrite"];
  importCache?: Pass2ResolverContext["importCache"];
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    createdCallEdges,
    globalNameToSymbolIds,
    telemetry,
    cache,
    mode,
    submitEdgeWrite,
    importCache,
  } = params;

  const conn = await getLadybugConn();
  const filePath = join(repoRoot, fileMeta.path);
  let content: string;
  try {
    content = await readFileAsync(filePath, "utf-8");
  } catch (readError: unknown) {
    const code = (readError as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EPERM") {
      logger.warn(
        `File disappeared before Rust pass2 resolution: ${fileMeta.path}`,
        { code },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(".rs");
  if (!adapter) {
    return 0;
  }

  const tree = adapter.parse(content, filePath);
  if (!tree) {
    return 0;
  }

  let extractedSymbols: ExtractedSymbol[];
  let calls: ExtractedCall[];
  let imports: ReturnType<typeof adapter.extractImports>;
  let receiverTypes: Map<string, string>;
  // Phase 2 Task 2.4.x — trait defaults + per-call Self::impl type are
  // computed while the tree is still live. Extracted outside the try
  // so they can be referenced after the tree is released.
  let traitDefaultsRaw: TraitDefaultMap = {
    traitDefaultMethods: new Map(),
    implementedTraitsByType: new Map(),
  };
  const selfImplTypeByCallKey = new Map<string, string>();
  try {
    extractedSymbols = adapter.extractSymbols(
      tree,
      content,
      filePath,
    ) as ExtractedSymbol[];
    calls = adapter.extractCalls(
      tree,
      content,
      filePath,
      extractedSymbols as never,
    ) as ExtractedCall[];
    imports = adapter.extractImports(tree, content, filePath);
    receiverTypes = inferRustReceiverTypes(tree);
    // Build trait default map using the raw extractedSymbols; the
    // `filteredSymbolDetails` layer is unavailable here, so pass a
    // synthesised list that only carries the nodeId + synthetic
    // symbolId so the helper's lookup still succeeds for the trait's
    // own method entries. The real symbolId mapping is applied later
    // via `normaliseTraitDefaultsWithSymbolIds`.
    traitDefaultsRaw = buildRustTraitDefaultMap(
      tree,
      extractedSymbols.map((es) => ({
        extractedSymbol: es,
        symbolId: es.nodeId,
      })),
    );
    // Pre-compute the enclosing impl type for every call site so the
    // resolver can answer `Self::method` lookups without re-walking
    // the tree per call.
    for (const c of calls) {
      const implType = findEnclosingImplType(
        tree,
        c.range.startLine - 1,
        c.range.startCol,
      );
      if (implType) {
        selfImplTypeByCallKey.set(callRangeKey(c.range), implType);
      }
    }
  } finally {
    (tree as unknown as { delete?: () => void }).delete?.();
  }

  const fileRecord = await ladybugDb.getFileByRepoPath(
    conn,
    repoId,
    fileMeta.path,
  );
  if (!fileRecord) {
    return 0;
  }

  const existingSymbols = await ladybugDb.getSymbolsByFile(
    conn,
    fileRecord.fileId,
  );
  if (existingSymbols.length === 0) {
    return 0;
  }

  const filteredSymbolDetails = mapExtractedSymbolsToExisting(
    fileMeta.path,
    extractedSymbols,
    existingSymbols,
    telemetry,
  );
  if (filteredSymbolDetails.length === 0) {
    return 0;
  }

  const symbolIdsToRefresh = filteredSymbolDetails.map(
    (detail) => detail.symbolId,
  );
  clearLocalCallDedupKeys(symbolIdsToRefresh, createdCallEdges);

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);
  const localImplMethodsByType = buildLocalImplMethodNamespaces(
    filteredSymbolDetails,
  );
  const receiverNamespaces = buildReceiverNamespaces(
    receiverTypes,
    localImplMethodsByType,
  );

  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    [...adapter.fileExtensions],
    "rust",
    content,
    importCache,
  );
  const importedNameToSymbolIds = mergeImportedNameMaps(
    importResolution.importedNameToSymbolIds,
    new Map(),
  );
  const explicitImportedNames = collectExplicitImportedNames(imports);

  const moduleIndex = await buildRustModuleIndex(repoId, cache);
  const currentModulePath = moduleIndex.modulePathByFilePath.get(fileMeta.path);
  const sameModuleSymbols = currentModulePath
    ? (moduleIndex.symbolsByModulePath.get(currentModulePath) ?? [])
    : [];
  const sameModuleNameToSymbolIds = buildSameModuleFunctionIndex(
    fileMeta.path,
    sameModuleSymbols,
  );
  const cratePathToSymbolIds = buildCratePathFunctionIndex(
    moduleIndex.symbolsByModulePath,
  );

  // Build external crate prefix set from file's imports (Step 2)
  const externalCratePrefixes = new Set<string>();
  for (const imp of imports) {
    if (imp.isExternal && imp.specifier) {
      const prefix = imp.specifier.split("::")[0];
      if (prefix) externalCratePrefixes.add(prefix);
    }
  }

  // Build symbolId → details map for disambiguation (Step 6)
  const symbolIdDetails = new Map<
    string,
    { filePath: string; exported: boolean }
  >();
  for (const [_modPath, symbols] of moduleIndex.symbolsByModulePath) {
    for (const sym of symbols) {
      symbolIdDetails.set(sym.symbolId, {
        filePath: sym.relPath,
        exported: sym.exported,
      });
    }
  }

  // Phase 2 Task 2.4.2 — precompute the alias->source map from the raw
  // source text so aliased `use` imports resolve via the existing
  // `importedNameToSymbolIds` index.
  const aliasToSourceName = buildRustUseAliasMap(content);

  // Phase 2 Task 2.4.1 — remap trait default method symbolIds from the
  // synthetic nodeIds populated during parsing to the real persisted
  // symbolIds (which are the keys we emit in call edges).
  const traitDefaults: TraitDefaultMap = {
    traitDefaultMethods: new Map(),
    implementedTraitsByType: traitDefaultsRaw.implementedTraitsByType,
  };
  const nodeIdToPersistedSymbolId = new Map<string, string>();
  for (const detail of filteredSymbolDetails) {
    nodeIdToPersistedSymbolId.set(
      detail.extractedSymbol.nodeId,
      detail.symbolId,
    );
  }
  for (const [traitName, methodMap] of traitDefaultsRaw.traitDefaultMethods) {
    const remapped = new Map<string, string>();
    for (const [methodName, syntheticId] of methodMap) {
      const persistedId = nodeIdToPersistedSymbolId.get(syntheticId);
      if (persistedId) {
        remapped.set(methodName, persistedId);
      }
    }
    if (remapped.size > 0) {
      traitDefaults.traitDefaultMethods.set(traitName, remapped);
    }
  }

  const now = new Date().toISOString();
  const edgesToInsert: ladybugDb.EdgeRow[] = [];
  let createdEdges = 0;

  for (const detail of filteredSymbolDetails) {
    for (const call of calls) {
      const callerNodeId =
        call.callerNodeId ??
        findEnclosingSymbolByRange(call.range, filteredSymbolDetails);
      if (callerNodeId !== detail.extractedSymbol.nodeId) {
        continue;
      }

      const selfImplType =
        selfImplTypeByCallKey.get(callRangeKey(call.range)) ?? null;
      const resolved = resolveRustPass2CallTarget({
        call,
        callerSymbol: detail.extractedSymbol,
        nodeIdToSymbolId,
        importedNameToSymbolIds,
        namespaceImports: importResolution.namespaceImports,
        localImplMethodsByType,
        receiverNamespaces,
        explicitImportedNames,
        sameModuleNameToSymbolIds,
        cratePathToSymbolIds,
        globalNameToSymbolIds,
        callerFilePath: fileMeta.path,
        symbolIdDetails,
        aliasToSourceName,
        traitDefaults,
        selfImplType,
        receiverTypes,
      });
      if (!resolved) {
        continue;
      }

      if (resolved.isResolved && resolved.symbolId) {
        const edgeKey = `${detail.symbolId}->${resolved.symbolId}`;
        if (createdCallEdges.has(edgeKey)) {
          continue;
        }
        edgesToInsert.push({
          repoId,
          fromSymbolId: detail.symbolId,
          toSymbolId: resolved.symbolId,
          edgeType: "call",
          weight: 1.0,
          confidence: resolved.confidence,
          resolution: resolved.resolution,
          resolverId: "pass2-rust",
          resolutionPhase: "pass2",
          provenance: `rust-call:${call.calleeIdentifier}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
        if (telemetry) {
          recordPass2ResolverEdge(
            telemetry,
            "pass2-rust",
            bucketForResolution(resolved.resolution),
          );
        }
      } else if (resolved.targetName) {
        // Skip Rust macro invocations (original identifier retains !)
        if (call.calleeIdentifier.endsWith("!")) {
          continue;
        }
        // Skip external crate calls (e.g. serde_json::from_str, tokio::spawn)
        if (isExternalCrateCall(resolved.targetName, externalCratePrefixes)) {
          continue;
        }
        // Skip known builtins (std methods, stripped macro names)
        if (isBuiltinCall(resolved.targetName)) {
          continue;
        }
        const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
        const edgeKey = `${detail.symbolId}->${unresolvedTargetId}`;
        if (createdCallEdges.has(edgeKey)) {
          continue;
        }
        edgesToInsert.push({
          repoId,
          fromSymbolId: detail.symbolId,
          toSymbolId: unresolvedTargetId,
          edgeType: "call",
          weight: 0.5,
          confidence: resolved.confidence,
          resolution: "unresolved",
          resolverId: "pass2-rust",
          resolutionPhase: "pass2",
          provenance: `unresolved-rust-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
        if (telemetry) {
          recordPass2ResolverUnresolved(telemetry, "pass2-rust", "unresolved");
        }
      }
    }
  }

  if (submitEdgeWrite) {
    await submitEdgeWrite({
      symbolIdsToRefresh,
      edges: edgesToInsert,
    });
  } else {
    await withWriteConn(async (wConn) => {
      if (mode !== "full" && symbolIdsToRefresh.length > 0) {
        await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
          wConn,
          symbolIdsToRefresh,
          "call",
        );
      }
      await ladybugDb.insertEdges(wConn, edgesToInsert);
    });
  }
  return createdEdges;
}

export class RustPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-rust";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "rust" && RUST_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("RustPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveRustCallEdgesPass2({
        repoId: target.repoId,
        repoRoot: context.repoRoot,
        fileMeta: {
          path: target.filePath,
          size: 0,
          mtime: 0,
        },
        createdCallEdges: context.createdCallEdges,
        globalNameToSymbolIds: context.globalNameToSymbolIds,
        telemetry: context.telemetry,
        cache: context.cache,
        mode: context.mode,
        submitEdgeWrite: context.submitEdgeWrite,
        importCache: context.importCache,
      });
      return { edgesCreated };
    } catch (error) {
      logger.warn(
        `Rust pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}

export {
  buildCratePathCandidates,
  buildCratePathFunctionIndex,
  buildLocalImplMethodNamespaces,
  buildRustModuleIndex,
  buildRustReExportsForFile,
  buildRustTraitDefaultMap,
  buildRustUseAliasMap,
  buildSameModuleFunctionIndex,
  callRangeKey,
  disambiguateRustCandidates,
  findEnclosingImplType,
  followRustBarrelChain,
  inferRustModulePath,
  inferRustReceiverTypes,
  isExternalCrateCall,
  KNOWN_EXTERNAL_CRATE_PREFIXES,
  normalizeRustTypeName,
  parseOwnerTypeFromNodeId,
  resolveRustPass2CallTarget,
  resolveTraitDefaultMethod,
};
export type { TraitDefaultMap };

/**
 * Phase 2 Task 2.4.2 — grouped / aliased `use` parser.
 *
 * Parses a Rust source file's `use` declarations from the raw text and
 * returns a list of per-name import bindings. Each binding records the
 * specifier the binding was declared under (e.g. `crate::utils`), the
 * name the caller uses locally (`localName`), and the name actually
 * exported by the target file (`sourceName`). For unaliased bindings
 * these are equal; for `bar as renamed` they differ.
 *
 * This is a text-based parser rather than an AST walk so it can be
 * unit tested without instantiating tree-sitter. It tolerates multiline
 * `use` declarations and nested group lists, which is enough for the
 * Task 2.4.2 acceptance fixtures; deeply nested groups and
 * conditional-compilation items are intentionally out of scope.
 */
export interface RustUseBinding {
  specifier: string;
  localName: string;
  sourceName: string;
  isReExport: boolean;
  isWildcard: boolean;
}

export function parseRustUseDeclarations(source: string): RustUseBinding[] {
  const bindings: RustUseBinding[] = [];
  // Strip line comments so comment text does not interfere with matching.
  const cleaned = source.replace(/\/\/[^\n]*/g, "");
  const useRegex = /\b(pub\s+)?use\s+([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(cleaned)) !== null) {
    const isReExport = Boolean(match[1]);
    const rawBody = match[2].replace(/\s+/g, " ").trim();
    parseRustUseBody(rawBody, isReExport, bindings);
  }
  return bindings;
}

function parseRustUseBody(
  body: string,
  isReExport: boolean,
  out: RustUseBinding[],
): void {
  const braceIdx = body.indexOf("{");
  if (braceIdx === -1) {
    parseRustUseLeaf(body, isReExport, out);
    return;
  }
  const prefix = body
    .slice(0, braceIdx)
    .replace(/::\s*$/, "")
    .trim();
  const closeIdx = body.lastIndexOf("}");
  if (closeIdx === -1 || closeIdx <= braceIdx) {
    return;
  }
  const inner = body.slice(braceIdx + 1, closeIdx).trim();
  const parts = splitTopLevelGroupList(inner);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes("{")) {
      // Nested group list — recurse with the combined prefix.
      const joined = prefix ? `${prefix}::${trimmed}` : trimmed;
      parseRustUseBody(joined, isReExport, out);
      continue;
    }
    const leaf = prefix ? `${prefix}::${trimmed}` : trimmed;
    parseRustUseLeaf(leaf, isReExport, out);
  }
}

function parseRustUseLeaf(
  leaf: string,
  isReExport: boolean,
  out: RustUseBinding[],
): void {
  const trimmed = leaf.trim();
  if (!trimmed) return;
  // Detect `as` alias clause (whitespace-delimited).
  const asMatch = trimmed.match(/^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  let pathText: string;
  let aliasName: string | null = null;
  if (asMatch) {
    pathText = asMatch[1].trim();
    aliasName = asMatch[2];
  } else {
    pathText = trimmed;
  }
  const isWildcard = pathText.endsWith("*");
  if (isWildcard) {
    const specifier = pathText.replace(/::\s*\*$/, "").trim();
    out.push({
      specifier,
      localName: "*",
      sourceName: "*",
      isReExport,
      isWildcard: true,
    });
    return;
  }
  const segments = pathText
    .split("::")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return;
  const sourceName = segments[segments.length - 1];
  if (sourceName === "self") {
    // `use foo::self` re-imports the module itself; bind the parent segment.
    if (segments.length >= 2) {
      const specifier = segments.slice(0, -2).join("::");
      const moduleName = segments[segments.length - 2];
      out.push({
        specifier,
        localName: aliasName ?? moduleName,
        sourceName: moduleName,
        isReExport,
        isWildcard: false,
      });
    }
    return;
  }
  const specifier = segments.slice(0, -1).join("::");
  out.push({
    specifier,
    localName: aliasName ?? sourceName,
    sourceName,
    isReExport,
    isWildcard: false,
  });
}

function splitTopLevelGroupList(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of inner) {
    if (ch === "{") {
      depth++;
      buf += ch;
    } else if (ch === "}") {
      depth--;
      buf += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}
