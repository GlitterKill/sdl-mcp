import { dirname, join } from "path";
import { platform } from "process";

import { getDb } from "../../db/db.js";
import {
  createEdgeTransaction,
  getEdgesByRepo,
  getFile,
  getFileByRepoPath,
  getFilesByRepo,
  getSymbol,
  getSymbolsByFileLite,
  getSymbolsByRepo,
} from "../../db/queries.js";
import type { EdgeRow, FileRow, SymbolRow } from "../../db/schema.js";
import { normalizePath } from "../../util/paths.js";

import { BUILTIN_CONSTRUCTORS, BUILTIN_IDENTIFIERS, isBuiltinCall } from "./builtins.js";

function cleanupUnresolvedEdges(repoId: string): void {
  const allEdges = getEdgesByRepo(repoId);
  const unresolvedEdges = allEdges.filter((edge: EdgeRow) =>
    edge.to_symbol_id.startsWith("unresolved:"),
  );

  const database = getDb();
  const deleteEdgeStmt = database.prepare(
    "DELETE FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?",
  );

  // IE-K.3: Node.js built-ins to skip
  const nodeBuiltins = new Set([
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "crypto",
    "dgram",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
  ]);

  // IE-K.3: Check if unresolved edge points to external package
  const isExternalPackage = (target: string, edgeType: string): boolean => {
    // Import edges: unresolved:package:name (e.g., unresolved:tree-sitter:Parser)
    if (edgeType === "import") {
      const parts = target.split(":");
      if (parts.length >= 3) {
        const packagePath = parts[1];
        // Skip if not relative path (i.e., external package)
        if (
          !packagePath.startsWith("./") &&
          !packagePath.startsWith("../") &&
          !packagePath.startsWith("/")
        ) {
          return true;
        }
      }
    }

    // Call edges: unresolved:call:name or unresolved:call:package:name
    // Check if name matches known patterns (Node.js built-ins or external packages)
    if (target.startsWith("unresolved:call:")) {
      const namePart = target.slice("unresolved:call:".length);
      // Skip if name is a Node.js builtin
      if (nodeBuiltins.has(namePart)) {
        return true;
      }
      // Skip built-in JS/TS method calls that can never resolve to repo symbols
      if (BUILTIN_IDENTIFIERS.has(namePart)) {
        return true;
      }
      // Skip built-in constructor calls
      if (BUILTIN_CONSTRUCTORS.has(namePart)) {
        return true;
      }
      // Skip if name contains package-like pattern (e.g., "tree-sitter:Parser")
      if (
        namePart.includes(":") &&
        !namePart.startsWith("./") &&
        !namePart.startsWith("../")
      ) {
        return true;
      }
    }

    return false;
  };

  // Cache repo symbols for call edge resolution
  let repoSymbols: SymbolRow[] | null = null;
  const getRepoSymbolsCached = () => {
    if (!repoSymbols) {
      repoSymbols = getSymbolsByRepo(repoId);
    }
    return repoSymbols;
  };

  // Cache symbol-to-file mapping
  const symbolToFile = new Map<string, FileRow | null>();
  const getSymbolFile = (symbolId: string): FileRow | null => {
    if (symbolToFile.has(symbolId)) {
      return symbolToFile.get(symbolId) ?? null;
    }
    const symbol = getSymbol(symbolId);
    if (!symbol) {
      symbolToFile.set(symbolId, null);
      return null;
    }
    const file = getFile(symbol.file_id);
    symbolToFile.set(symbolId, file ?? null);
    return file ?? null;
  };

  for (const edge of unresolvedEdges) {
    const target = edge.to_symbol_id;

    // Delete built-in JS/TS method and constructor call edges that can never resolve.
    // These inflate the totalCallEdges denominator without providing value.
    if (target.startsWith("unresolved:call:")) {
      const namePart = target.slice("unresolved:call:".length);
      if (isBuiltinCall(namePart)) {
        deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);
        continue;
      }
    }

    // IE-K.3: External package edges - delete call edges (they inflate the
    // denominator), skip import edges (they represent real dependencies).
    if (isExternalPackage(target, edge.type)) {
      if (edge.type === "call") {
        deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);
      }
      continue;
    }

    let matchingSymbolId: string | undefined;
    let isUniqueMatch = false;

    // Format 1: unresolved:call:functionName - simple call edge
    const callMatch = target.match(/^unresolved:call:(.+)$/);
    if (callMatch) {
      const targetName = callMatch[1];
      // Find ALL matches to determine uniqueness for confidence scoring
      const allMatches = getRepoSymbolsCached().filter((sym: SymbolRow) => {
        if (sym.name === targetName) return true;
        if (targetName.includes(":")) {
          const parts: string[] = targetName.split(":");
          return parts.some((part: string) => sym.name === part);
        }
        return false;
      });
      if (allMatches.length > 0) {
        matchingSymbolId = allMatches[0].symbol_id;
        isUniqueMatch = allMatches.length === 1;
      }
    }

    // Format 2: unresolved:path/to/file.js:symbolName - import edge with file path
    // Skip namespace imports (* as X) and star imports (*)
    if (!callMatch && !target.includes(":*")) {
      // Parse: unresolved:path:symbolName (last colon separates path from symbol)
      const lastColon = target.lastIndexOf(":");
      if (lastColon > 11) {
        // "unresolved:".length = 11
        const pathPart = target.slice(11, lastColon);
        const symbolName = target.slice(lastColon + 1);

        // Get the source file to resolve relative paths
        const sourceFile = getSymbolFile(edge.from_symbol_id);

        if (
          sourceFile &&
          (pathPart.startsWith("./") || pathPart.startsWith("../"))
        ) {
          // Resolve relative path from source file's directory
          const sourceDir = dirname(sourceFile.rel_path);
          const joinedPath = join(sourceDir, pathPart);
          const normalizedJoined = normalizePath(joinedPath);

          // Try multiple path variants for better matching
          const pathVariants: string[] = [
            // Normalized path with original extension
            normalizedJoined,
            // .js -> .ts conversion
            normalizedJoined.replace(/\.js$/, ".ts"),
            // .jsx -> .tsx conversion
            normalizedJoined.replace(/\.jsx$/, ".tsx"),
            // Try with .ts extension if no extension
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
              ? `${normalizedJoined}.ts`
              : normalizedJoined,
            // Try with .js extension if no extension
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
              ? `${normalizedJoined}.js`
              : normalizedJoined,
            // Try index.ts (with and without trailing slash)
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.ts",
            // Try index.js
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.js",
            // Try removing any extension and keeping as directory
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, ""),
          ];

          // Remove duplicates from variants
          const uniqueVariants = [...new Set(pathVariants)];

          for (const variant of uniqueVariants) {
            const targetFile = getFileByRepoPath(repoId, variant);
            if (targetFile) {
              // Find exported symbol by name in that file
              const fileSymbols = getSymbolsByFileLite(
                targetFile.file_id,
              ).filter((s) => s.exported === 1);
              const match = fileSymbols.find((s) => s.name === symbolName);
              if (match) {
                matchingSymbolId = match.symbol_id;
                break;
              }

              // Fallback: if single export and looking for default
              if (!matchingSymbolId && fileSymbols.length === 1) {
                matchingSymbolId = fileSymbols[0].symbol_id;
                break;
              }
            }

            // IE-K.2: Try case-insensitive matching on Windows
            if (!matchingSymbolId && platform === "win32") {
              const allFiles = getFilesByRepo(repoId);
              const caseInsensitiveMatch = allFiles.find(
                (f) => f.rel_path.toLowerCase() === variant.toLowerCase(),
              );
              if (caseInsensitiveMatch) {
                const fileSymbols = getSymbolsByFileLite(
                  caseInsensitiveMatch.file_id,
                ).filter((s) => s.exported === 1);
                const match = fileSymbols.find((s) => s.name === symbolName);
                if (match) {
                  matchingSymbolId = match.symbol_id;
                  break;
                }

                // Fallback: if single export and looking for default
                if (!matchingSymbolId && fileSymbols.length === 1) {
                  matchingSymbolId = fileSymbols[0].symbol_id;
                  break;
                }
              }
            }
          }
        } else if (!pathPart.startsWith("./") && !pathPart.startsWith("../")) {
          // Non-relative import (node_modules, etc.) - skip
          continue;
        }
      }
    }

    if (matchingSymbolId) {
      deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);

      // Set proper strategy/confidence based on match quality instead of
      // copying the original "unresolved" strategy and low confidence.
      const resolvedStrategy: "heuristic" | "exact" = callMatch
        ? "heuristic"
        : (edge.resolution_strategy === "exact" ? "exact" : "heuristic");
      const resolvedConfidence = callMatch
        ? (isUniqueMatch ? 0.9 : 0.5)
        : ((edge.confidence ?? 0) >= 0.9 ? edge.confidence! : 0.7);

      createEdgeTransaction({
        repo_id: edge.repo_id,
        from_symbol_id: edge.from_symbol_id,
        to_symbol_id: matchingSymbolId,
        type: edge.type,
        weight: edge.type === "import" ? 0.6 : 1.0,
        confidence: resolvedConfidence,
        resolution_strategy: resolvedStrategy,
        provenance: edge.provenance,
        created_at: new Date().toISOString(),
      });
    } else if (callMatch) {
      // Unresolved call edge with no matching symbol in the repo.
      // These are calls to external APIs (VS Code, D3, TypeScript compiler,
      // etc.) that will never resolve. Delete them to avoid inflating the
      // totalCallEdges denominator.
      deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);
    }
  }
}

export { cleanupUnresolvedEdges };
