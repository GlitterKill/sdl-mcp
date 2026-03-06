const fs = require('fs');

function fixBenchmark() {
    let content = fs.readFileSync('scripts/real-world-benchmark.ts', 'utf8');

    // 1. Imports
    content = content.replace(
        'import { getDb } from "../src/db/db.js";',
        'import { initKuzuDb, getKuzuConn } from "../src/db/kuzu.js";\nimport type { Connection } from "kuzu";'
    );
    content = content.replace('import { runMigrations } from "../src/db/migrations.js";\n', '');
    content = content.replace(
        'import * as db from "../src/db/queries.js";',
        'import * as db from "../src/db/kuzu-queries.js";'
    );

    // 2. runBenchmark Db Init
    content = content.replace(
        'const database = getDb(config.dbPath);',
        'await initKuzuDb(config.dbPath);\n  const conn = await getKuzuConn();'
    );
    content = content.replace('runMigrations(database);\n', '');

    // 3. Make functions async
    content = content.replace(/function buildFileSymbolNameMap\(/g, 'async function buildFileSymbolNameMap(conn: Connection, ');
    content = content.replace(/function buildFileRepresentativeSymbolMap\(/g, 'async function buildFileRepresentativeSymbolMap(conn: Connection, ');
    content = content.replace(/function findSymbolsByName\(/g, 'async function findSymbolsByName(conn: Connection, ');
    content = content.replace(/function scoreSymbolCandidate\(/g, 'async function scoreSymbolCandidate(conn: Connection, ');
    content = content.replace(/function searchSymbolsByTerms\(/g, 'async function searchSymbolsByTerms(conn: Connection, ');
    content = content.replace(/function collectDependencyNames\(/g, 'async function collectDependencyNames(conn: Connection, ');
    content = content.replace(/function applyCardContext\(/g, 'async function applyCardContext(conn: Connection, ');

    // 4. Update db.* calls
    content = content.replace(/db\.getFilesByRepoLite\(([^)]+)\)/g, 'await db.getFilesByRepoLite(conn, $1)');
    content = content.replace(/db\.getSymbolsByFileLite\(([^)]+)\)/g, 'await db.getSymbolsByFileLite(conn, $1)');
    content = content.replace(/db\.searchSymbols\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, 'await db.searchSymbols(conn, $1, $2, $3)');
    content = content.replace(/db\.getFile\(([^)]+)\)/g, 'await db.getFile(conn, $1)');
    content = content.replace(/db\.getSymbol\(([^)]+)\)/g, 'await db.getSymbol(conn, $1)');
    content = content.replace(/db\.getLatestVersion\(([^)]+)\)/g, 'await db.getLatestVersion(conn, $1)');
    content = content.replace(/db\.getRepo\(([^)]+)\)/g, 'await db.getRepo(conn, $1)');
    content = content.replace(/db\.createRepo\(/g, 'await db.upsertRepo(conn, ');

    // 5. Property names
    content = content.replace(/\.file_id/g, '.fileId');
    content = content.replace(/\.symbol_id/g, '.symbolId');
    content = content.replace(/\.rel_path/g, '.relPath');
    content = content.replace(/\.version_id/g, '.versionId');

    // 6. Update function calls (use lookbehind or precise matching)
    content = content.replace(/const fileSymbolMap = buildFileSymbolNameMap\(([^)]+)\);/g, 'const fileSymbolMap = await buildFileSymbolNameMap(conn, $1);');
    content = content.replace(/const fileRepresentativeSymbolMap = buildFileRepresentativeSymbolMap\(([^)]+)\);/g, 'const fileRepresentativeSymbolMap = await buildFileRepresentativeSymbolMap(conn, $1);');
    content = content.replace(/const hintMatches = findSymbolsByName\(([^)]+)\);/g, 'const hintMatches = await findSymbolsByName(conn, $1);');
    content = content.replace(/const names = collectDependencyNames\(([^)]+)\);/g, 'const names = await collectDependencyNames(conn, $1);');
    
    // searchSymbolsByTerms is multiline
    content = content.replace(/const searchMatches = shouldRunSearch\s*\?\s*searchSymbolsByTerms\(([\s\S]*?)\)\s*:\s*\[\];/g, 
    (match, args) => `const searchMatches = shouldRunSearch ? await searchSymbolsByTerms(conn, ${args.trim()}) : [];`);

    // applyCardContext
    content = content.replace(/applyCardContext\(state, card\);/g, 'await applyCardContext(conn, state, card);');
    
    // 7. runCompletionPass & runSdlStep
    content = content.replace(/async function runCompletionPass\(/, 'async function runCompletionPass(conn: Connection, ');
    content = content.replace(/await runCompletionPass\(([^c])/g, 'await runCompletionPass(conn, $1');
    
    content = content.replace(/async function runSdlStep\(/, 'async function runSdlStep(conn: Connection, ');
    content = content.replace(/await runSdlStep\(([^c])/g, 'await runSdlStep(conn, $1');

    // 8. Fix Array.sort with scoreSymbolCandidate
    const sortBlock = `const ranked = Array.from(deduped.values()).sort((a, b) => {
    const aIsHint = hintSymbolIds.has(a.symbolId);
    const bIsHint = hintSymbolIds.has(b.symbolId);
    if (aIsHint !== bIsHint) return aIsHint ? -1 : 1;

    const aScore = scoreSymbolCandidate(a, terms, changedFiles);
    const bScore = scoreSymbolCandidate(b, terms, changedFiles);
    if (bScore !== aScore) return bScore - aScore;
    return a.name.localeCompare(b.name);
  });`;

    const newSortBlock = `const scoredEntries = await Promise.all(Array.from(deduped.values()).map(async (sym) => {
    const score = await scoreSymbolCandidate(conn, sym, terms, changedFiles);
    return { sym, score };
  }));
  const ranked = scoredEntries.sort((a, b) => {
    const aIsHint = hintSymbolIds.has(a.sym.symbolId);
    const bIsHint = hintSymbolIds.has(b.sym.symbolId);
    if (aIsHint !== bIsHint) return aIsHint ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.sym.name.localeCompare(b.sym.name);
  }).map(e => e.sym);`;

    content = content.replace(sortBlock, newSortBlock);

    fs.writeFileSync('scripts/real-world-benchmark.ts', content);
    console.log("Refactor complete.");
}

fixBenchmark();
