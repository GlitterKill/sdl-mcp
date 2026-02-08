#!/usr/bin/env tsx
/**
 * Debug skeleton generation step by step
 */

import { readFileSync, existsSync } from "fs";
import { getDb } from "../src/db/db.js";
import { runMigrations } from "../src/db/migrations.js";
import { loadConfig } from "../src/config/loadConfig.js";
import * as db from "../src/db/queries.js";
import { getAbsolutePathFromRepoRoot } from "../src/util/paths.js";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

const config = loadConfig();
const database = getDb(config.dbPath);
runMigrations(database);

const repoId = config.repos[0].repoId;
console.log(`Testing skeleton generation for repo: ${repoId}\n`);

// Get a function symbol from src/
const allSymbols = db.getSymbolsByRepo(repoId);
const srcFunctions = allSymbols.filter(s => {
  if (s.kind !== "function") return false;
  const file = db.getFile(s.file_id);
  return file?.rel_path.startsWith("src/");
});

console.log(`Found ${srcFunctions.length} function symbols in src/\n`);

// Test first 3 symbols
for (const symbol of srcFunctions.slice(0, 3)) {
  console.log(`=== Testing: ${symbol.name} ===`);

  // Step 1: Get symbol
  const sym = db.getSymbol(symbol.symbol_id);
  console.log(`1. Symbol found: ${!!sym}`);
  if (!sym) continue;

  // Step 2: Get file
  const file = db.getFile(sym.file_id);
  console.log(`2. File found: ${!!file}`);
  if (!file) continue;
  console.log(`   File path: ${file.rel_path}`);

  // Step 3: Get repo
  const repo = db.getRepo(repoId);
  console.log(`3. Repo found: ${!!repo}`);
  if (!repo) continue;
  console.log(`   Root path: ${repo.root_path}`);

  // Step 4: Build absolute path
  const filePath = getAbsolutePathFromRepoRoot(repo.root_path, file.rel_path);
  console.log(`4. Absolute path: ${filePath}`);
  console.log(`   Path exists: ${existsSync(filePath)}`);

  if (!existsSync(filePath)) continue;

  // Step 5: Read file
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
    console.log(`5. File read: ${content.length} chars, ${content.split('\n').length} lines`);
  } catch (e) {
    console.log(`5. File read error: ${e}`);
    continue;
  }

  // Step 6: Get extension and parse
  const extension = file.rel_path.split(".").pop() || "";
  console.log(`6. Extension: .${extension}`);

  const isTS = extension === "ts";
  const isTSX = extension === "tsx";
  const isJS = extension === "js";
  const isJSX = extension === "jsx";

  if (!isTS && !isTSX && !isJS && !isJSX) {
    console.log(`   Unsupported extension`);
    continue;
  }

  // Step 7: Initialize parser
  console.log(`7. Initializing parser for .${extension}`);
  const parser = new Parser();
  try {
    if (isTS) {
      parser.setLanguage(TypeScript.typescript);
    } else {
      parser.setLanguage(TypeScript.tsx);
    }
    console.log(`   Parser language set`);
  } catch (e) {
    console.log(`   Parser language error: ${e}`);
    continue;
  }

  // Step 8: Parse file
  let tree: Parser.Tree;
  try {
    tree = parser.parse(content);
    console.log(`8. Tree parsed: ${!!tree}`);
    if (tree) {
      console.log(`   Root node type: ${tree.rootNode.type}`);
      console.log(`   Has errors: ${tree.rootNode.hasError}`);
      console.log(`   Child count: ${tree.rootNode.childCount}`);
    }
  } catch (e) {
    console.log(`8. Parse error: ${e}`);
    continue;
  }

  if (!tree || tree.rootNode.hasError) {
    console.log(`   Skipping due to parse errors`);
    continue;
  }

  // Step 9: Symbol range
  const symbolRange = {
    startLine: sym.range_start_line,
    endLine: sym.range_end_line,
  };
  console.log(`9. Symbol range: lines ${symbolRange.startLine}-${symbolRange.endLine}`);

  // Step 10: Find node by range (FIXED ALGORITHM)
  function findNodeByRange(
    node: Parser.SyntaxNode,
    range: { startLine: number; endLine: number },
  ): Parser.SyntaxNode | null {
    const targetStart = range.startLine - 1; // Convert to 0-based
    const targetEnd = range.endLine - 1;

    // Check if this node SPANS (contains) the target range
    const nodeContainsRange =
      node.startPosition.row <= targetStart &&
      node.endPosition.row >= targetEnd;

    if (!nodeContainsRange) {
      return null;
    }

    // This node contains the target range. Try to find a more specific child.
    for (const child of node.children) {
      const found = findNodeByRange(child, range);
      if (found) {
        return found;
      }
    }

    // No child contains the full target range. Return this node.
    return node;
  }

  const symbolNode = findNodeByRange(tree.rootNode, symbolRange);
  console.log(`10. Symbol node found: ${!!symbolNode}`);
  if (symbolNode) {
    console.log(`    Node type: ${symbolNode.type}`);
    console.log(`    Node range: ${symbolNode.startPosition.row + 1}-${symbolNode.endPosition.row + 1}`);
  } else {
    // Debug: show what nodes exist at that range
    console.log(`    Debugging: Looking for nodes around lines ${symbolRange.startLine}-${symbolRange.endLine}`);
    function showNodesAtRange(node: Parser.SyntaxNode, depth = 0): void {
      const nodeStart = node.startPosition.row + 1;
      const nodeEnd = node.endPosition.row + 1;
      if (nodeStart <= symbolRange.endLine && nodeEnd >= symbolRange.startLine) {
        console.log(`    ${"  ".repeat(depth)}${node.type} (${nodeStart}-${nodeEnd})`);
        if (depth < 3) {
          for (const child of node.children) {
            showNodesAtRange(child, depth + 1);
          }
        }
      }
    }
    showNodesAtRange(tree.rootNode);
  }

  console.log("");
}
