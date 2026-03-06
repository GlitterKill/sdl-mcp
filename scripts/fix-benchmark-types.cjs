const fs = require('fs');
let code = fs.readFileSync('scripts/real-world-benchmark.ts', 'utf8');

// Fix SymbolRow import
code = code.replace(
  'import type { SymbolRow } from "../src/db/schema.js";',
  'import type { SymbolRow } from "../src/db/kuzu-queries.js";'
);

// Fix getSymbolsByFileLite -> getSymbolsByFile
code = code.replace(/db\.getSymbolsByFileLite/g, 'db.getSymbolsByFile');

// Fix db.getFile -> db.getFilesByIds
code = code.replace(/await db\.getFile\(conn,\s*([^)]+)\)/g, '(await db.getFilesByIds(conn, [$1]))[0]');

// Fix runMigrations leftover
code = code.replace(/import { runMigrations } from "\.\.\/src\/db\/migrations\.js";\r?\n/g, '');

// Fix return types of functions we made async
code = code.replace(/async function buildFileSymbolNameMap\(([^)]+)\):\s*Map<string, Set<string>>/, 'async function buildFileSymbolNameMap($1): Promise<Map<string, Set<string>>>');
code = code.replace(/async function buildFileRepresentativeSymbolMap\(([^)]+)\):\s*Map<string, string>/, 'async function buildFileRepresentativeSymbolMap($1): Promise<Map<string, string>>');
code = code.replace(/async function findSymbolsByName\(([^)]+)\):\s*SymbolRow\[\]/, 'async function findSymbolsByName($1): Promise<SymbolRow[]>');
code = code.replace(/async function scoreSymbolCandidate\(([^)]+)\):\s*number/, 'async function scoreSymbolCandidate($1): Promise<number>');
code = code.replace(/async function searchSymbolsByTerms\(([^)]+)\):\s*SymbolRow\[\]/, 'async function searchSymbolsByTerms($1): Promise<SymbolRow[]>');
code = code.replace(/async function collectDependencyNames\(([^)]+)\):\s*Set<string>/, 'async function collectDependencyNames($1): Promise<Set<string>>');
code = code.replace(/async function applyCardContext\(([^)]+)\):\s*void/, 'async function applyCardContext($1): Promise<void>');

// Fix repo_id: repoConfig.repoId -> repoId: repoConfig.repoId
code = code.replace(/repo_id:\s*repoConfig\.repoId/g, 'repoId: repoConfig.repoId');

// Fix missing await on skeleton.skeleton ? Wait, skeleton is a Promise? 
// In runSdlStep: const skeleton = generateSymbolSkeleton(...) ?
// Let's make sure it's await generateSymbolSkeleton.
code = code.replace(/const skeleton = generateSymbolSkeleton\(/g, 'const skeleton = await generateSymbolSkeleton(');

// Also remove `database` reference if it still exists.
code = code.replace(/runMigrations\(database\);\r?\n/g, '');

fs.writeFileSync('scripts/real-world-benchmark.ts', code);
console.log('Fixed types and leftover errors.');
