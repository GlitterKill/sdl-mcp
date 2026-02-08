import { readFileSync } from "fs";
import { join } from "path";
import type { RepoConfig } from "../config/types.js";
import { getFilesByRepo, getSymbolsByRepo } from "../db/queries.js";
import type { SymbolRow } from "../db/schema.js";
import { parseFile } from "./treesitter/tsTreesitter.js";
import type Parser from "tree-sitter";

export interface ConfigEdge {
  fromSymbolId: string;
  toSymbolId: string;
  weight?: number;
  provenance?: string;
}

export interface ConfigEdgeContext {
  repoId: string;
  repoRoot: string;
  config: RepoConfig;
}

export interface ConfigEdgeExtractor {
  id: string;
  extract: (context: ConfigEdgeContext) => ConfigEdge[];
}

const expressExtractor: ConfigEdgeExtractor = {
  id: "express-routes",
  extract: (context) => extractExpressEdges(context),
};

export const defaultConfigEdgeExtractors: ConfigEdgeExtractor[] = [
  expressExtractor,
];

export interface PerTreeConfigEdgeContext {
  repoId: string;
  repoRoot: string;
  config: RepoConfig;
  tree: Parser.Tree;
  fileSymbols: SymbolRow[];
  allSymbolsByName: Map<string, SymbolRow[]>;
}

export function extractConfigEdgesFromTree(
  context: PerTreeConfigEdgeContext,
  extractors: ConfigEdgeExtractor[] = defaultConfigEdgeExtractors,
): ConfigEdge[] {
  const edges: ConfigEdge[] = [];
  for (const extractor of extractors) {
    if (extractor.id === "express-routes") {
      try {
        edges.push(...extractExpressEdgesFromTree(context));
      } catch (error) {
        console.warn(`Config edge extractor failed: ${extractor.id}`, error);
      }
    }
  }
  return edges;
}

function extractExpressEdgesFromTree(
  context: PerTreeConfigEdgeContext,
): ConfigEdge[] {
  const { tree, fileSymbols, allSymbolsByName } = context;
  const edges: ConfigEdge[] = [];
  const routeMethods = new Set([
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "options",
    "head",
    "use",
  ]);

  const root = tree.rootNode;
  const queue = [root];

  while (queue.length > 0) {
    const node = queue.pop();
    if (!node) continue;

    if (node.type === "call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode?.type === "member_expression") {
        const objectNode = fnNode.childForFieldName("object");
        const propertyNode = fnNode.childForFieldName("property");
        const objectName = objectNode?.text;
        const methodName = propertyNode?.text;

        if (
          objectName &&
          (objectName === "app" || objectName === "router") &&
          methodName &&
          routeMethods.has(methodName)
        ) {
          const argsNode = node.childForFieldName("arguments");
          const args = argsNode?.namedChildren ?? [];
          const handlerNode = args[args.length - 1];
          const handlerName = extractHandlerName(handlerNode);
          if (!handlerName) {
            continue;
          }

          const handlerSymbol = resolveHandlerSymbol(
            handlerName,
            fileSymbols,
            allSymbolsByName,
          );
          if (!handlerSymbol) {
            continue;
          }

          const position = {
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          };
          const container =
            resolveHandlerSymbol(objectName, fileSymbols, allSymbolsByName) ??
            findEnclosingSymbol(fileSymbols, position);
          if (!container || container.symbol_id === handlerSymbol.symbol_id) {
            continue;
          }

          edges.push({
            fromSymbolId: container.symbol_id,
            toSymbolId: handlerSymbol.symbol_id,
            provenance: `express:${methodName}`,
          });
        }
      }
    }

    queue.push(...node.namedChildren);
  }

  return edges;
}

export function extractConfigEdges(
  context: ConfigEdgeContext,
  extractors: ConfigEdgeExtractor[] = defaultConfigEdgeExtractors,
): ConfigEdge[] {
  const edges: ConfigEdge[] = [];
  for (const extractor of extractors) {
    try {
      edges.push(...extractor.extract(context));
    } catch (error) {
      console.warn(`Config edge extractor failed: ${extractor.id}`, error);
    }
  }
  return edges;
}

function extractExpressEdges(context: ConfigEdgeContext): ConfigEdge[] {
  const { repoId, repoRoot, config } = context;
  const files = getFilesByRepo(repoId);
  const symbols = getSymbolsByRepo(repoId);
  const symbolsByFile = new Map<number, SymbolRow[]>();
  const nameToSymbols = new Map<string, SymbolRow[]>();

  for (const symbol of symbols) {
    const byFile = symbolsByFile.get(symbol.file_id) ?? [];
    byFile.push(symbol);
    symbolsByFile.set(symbol.file_id, byFile);

    const byName = nameToSymbols.get(symbol.name) ?? [];
    byName.push(symbol);
    nameToSymbols.set(symbol.name, byName);
  }

  const edges: ConfigEdge[] = [];
  const routeMethods = new Set([
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "options",
    "head",
    "use",
  ]);

  for (const file of files) {
    const language = file.language as RepoConfig["languages"][number];
    if (!config.languages.includes(language)) {
      continue;
    }

    const filePath = join(repoRoot, file.rel_path);
    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const extension = extensionFromLanguage(language);
    if (!extension) {
      continue;
    }
    const parseResult = parseFile(content, extension);
    if (!parseResult) {
      continue;
    }

    const fileSymbols = symbolsByFile.get(file.file_id) ?? [];
    const root = parseResult.tree.rootNode;
    const queue = [root];

    while (queue.length > 0) {
      const node = queue.pop();
      if (!node) continue;

      if (node.type === "call_expression") {
        const fnNode = node.childForFieldName("function");
        if (fnNode?.type === "member_expression") {
          const objectNode = fnNode.childForFieldName("object");
          const propertyNode = fnNode.childForFieldName("property");
          const objectName = objectNode?.text;
          const methodName = propertyNode?.text;

          if (
            objectName &&
            (objectName === "app" || objectName === "router") &&
            methodName &&
            routeMethods.has(methodName)
          ) {
            const argsNode = node.childForFieldName("arguments");
            const args = argsNode?.namedChildren ?? [];
            const handlerNode = args[args.length - 1];
            const handlerName = extractHandlerName(handlerNode);
            if (!handlerName) {
              continue;
            }

            const handlerSymbol = resolveHandlerSymbol(
              handlerName,
              fileSymbols,
              nameToSymbols,
            );
            if (!handlerSymbol) {
              continue;
            }

            const position = {
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
            };
            const container =
              resolveHandlerSymbol(objectName, fileSymbols, nameToSymbols) ??
              findEnclosingSymbol(fileSymbols, position);
            if (!container || container.symbol_id === handlerSymbol.symbol_id) {
              continue;
            }

            edges.push({
              fromSymbolId: container.symbol_id,
              toSymbolId: handlerSymbol.symbol_id,
              provenance: `express:${methodName}`,
            });
          }
        }
      }

      queue.push(...node.namedChildren);
    }
  }

  return edges;
}

function extractHandlerName(node: any): string | null {
  if (!node) return null;
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property");
    if (property?.text) {
      return property.text;
    }
  }
  return null;
}

function resolveHandlerSymbol(
  handlerName: string,
  fileSymbols: SymbolRow[],
  nameToSymbols: Map<string, SymbolRow[]>,
): SymbolRow | null {
  const localMatches = fileSymbols.filter(
    (symbol) => symbol.name === handlerName,
  );
  if (localMatches.length === 1) {
    return localMatches[0];
  }

  const globalMatches = nameToSymbols.get(handlerName) ?? [];
  if (globalMatches.length === 1) {
    return globalMatches[0];
  }

  return null;
}

function findEnclosingSymbol(
  symbols: SymbolRow[],
  position: { line: number; col: number },
): SymbolRow | null {
  let best: { symbol: SymbolRow; size: number } | null = null;
  for (const symbol of symbols) {
    if (position.line < symbol.range_start_line) continue;
    if (position.line > symbol.range_end_line) continue;
    if (
      position.line === symbol.range_start_line &&
      position.col < symbol.range_start_col
    ) {
      continue;
    }
    if (
      position.line === symbol.range_end_line &&
      position.col > symbol.range_end_col
    ) {
      continue;
    }

    const size =
      symbol.range_end_line -
      symbol.range_start_line +
      (symbol.range_end_col - symbol.range_start_col);
    if (!best || size < best.size) {
      best = { symbol, size };
    }
  }

  return best?.symbol ?? null;
}

function extensionFromLanguage(
  language: string,
): ".ts" | ".tsx" | ".js" | ".jsx" | null {
  switch (language) {
    case "ts":
      return ".ts";
    case "tsx":
      return ".tsx";
    case "js":
      return ".js";
    case "jsx":
      return ".jsx";
    default:
      return null;
  }
}
