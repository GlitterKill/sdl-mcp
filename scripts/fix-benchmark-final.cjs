const fs = require('fs');
let code = fs.readFileSync('scripts/real-world-benchmark.ts', 'utf8');

// Fix exported boolean
code = code.replace(/symbol\.exported === 1/g, 'symbol.exported');

// Fix missing await on scoreSymbolCandidate
code = code.replace(/const extra = scoreSymbolCandidate\(([^)]+)\);/g, 'const extra = await scoreSymbolCandidate(conn, $1);');

// Fix applyCardContext missing 3rd argument
code = code.replace(/applyCardContext\(sdlState, card\)/g, 'await applyCardContext(conn, sdlState, card)');
code = code.replace(/applyCardContext\(sdlState, inflatedCard\)/g, 'await applyCardContext(conn, sdlState, inflatedCard)');
code = code.replace(/applyCardContext\(sdlState, cachedCard\)/g, 'await applyCardContext(conn, sdlState, cachedCard)');
code = code.replace(/applyCardContext\(state, inflatedCard\)/g, 'await applyCardContext(conn, state, inflatedCard)');
code = code.replace(/applyCardContext\(state, cachedCard\)/g, 'await applyCardContext(conn, state, cachedCard)');

// Fix searchPayloadLimit map
code = code.replace(/const searchPayload = ranked\.slice\(0, searchPayloadLimit\)\.map\(\(symbol\) => \{/g, 'const searchPayload = await Promise.all(ranked.slice(0, searchPayloadLimit).map(async (symbol) => {');
// we need to close the parenthesis for Promise.all
// But wait, it's easier to just make it async inline.
code = code.replace(/const searchTokens = estimateTokens\(JSON\.stringify\(searchPayload\)\);/, 'const searchTokens = estimateTokens(JSON.stringify(searchPayload));');

// Fix the map async issue:
// The map inside searchPayload is async now because `await db.getFile` is inside it.
// Original:
/*
  const searchPayload = ranked.slice(0, searchPayloadLimit).map((symbol) => {
    const file = await db.getFile(conn, symbol.fileId);
    ...
  });
*/
// Replace with:
/*
  const searchPayload = await Promise.all(ranked.slice(0, searchPayloadLimit).map(async (symbol) => { ... }));
*/
code = code.replace(/const searchPayload = ranked\.slice\(0, searchPayloadLimit\)\.map\(\(symbol\) => \{/g, 'const searchPayload = await Promise.all(ranked.slice(0, searchPayloadLimit).map(async (symbol) => {'));
code = code.replace(/  \}\);\r?\n\r?\n  const searchTokens/g, '  }));\n\n  const searchTokens');

// Also fix repo_root -> rootPath if needed
code = code.replace(/root_path:/g, 'rootPath:');

fs.writeFileSync('scripts/real-world-benchmark.ts', code);
console.log('Fixed final types');
