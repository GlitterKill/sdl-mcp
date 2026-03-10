const fs = require('fs');

let code = fs.readFileSync('src/db/ladybug-queries.ts', 'utf8');

// Replace string interpolation of limits
code = code.replace(/LIMIT \$\{safeLimit\}/g, 'LIMIT $limit');
code = code.replace(/LIMIT \$\{limit\}/g, 'LIMIT $limit');

// Remove the comments that say "NOTE: Kuzu prepared statements appear to crash when LIMIT is parameterized..."
code = code.replace(/\/\/ NOTE: Kuzu prepared statements appear to crash when LIMIT is parameterized,\s*\/\/ so we inline a validated safe integer\.\s*/g, '');

// Now we need to make sure the params object includes `{ limit: safeLimit }` or `{ limit }`.
// In searchSymbols / searchSymbolsLite, the params object is `{ repoId, query: trimmed }`. We need to add limit.
code = code.replace(/\{ repoId, query: trimmed \},/g, '{ repoId, query: trimmed, limit: safeLimit },');

// In getVersions, listRepos, getAuditTrail, etc, where params might already be there:
// For listRepos: already has `{ limit }`
// For getVersions: `{ repoId }` -> `{ repoId, limit: safeLimit }`
code = code.replace(/\{ repoId \},\s*\);\s*\}/g, '{ repoId, limit: safeLimit },\n  );\n}');
// but sometimes safeLimit doesn't exist, we must be careful.
fs.writeFileSync('src/db/ladybug-queries.ts', code);
console.log('Fixed ladybug-queries.ts');
