import { Project, SyntaxKind } from "ts-morph";

const project = new Project();
project.addSourceFileAtPath("scripts/real-world-benchmark.ts");
const sourceFile = project.getSourceFileOrThrow("scripts/real-world-benchmark.ts");

// 1. Fix Imports
const dbImport = sourceFile.getImportDeclaration(decl => decl.getModuleSpecifierValue() === "../src/db/db.js");
if (dbImport) {
    dbImport.setModuleSpecifier("../src/db/kuzu.js");
    dbImport.getNamedImports().forEach(i => i.remove());
    dbImport.addNamedImports([{ name: "initKuzuDb" }, { name: "getKuzuConn" }]);
}

const migrationsImport = sourceFile.getImportDeclaration(decl => decl.getModuleSpecifierValue() === "../src/db/migrations.js");
if (migrationsImport) {
    migrationsImport.remove();
}

const queriesImport = sourceFile.getImportDeclaration(decl => decl.getModuleSpecifierValue() === "../src/db/queries.js");
if (queriesImport) {
    queriesImport.setModuleSpecifier("../src/db/kuzu-queries.js");
}

// 2. Fix Db Init in runBenchmark
const runBenchmark = sourceFile.getFunction("runBenchmark");
if (runBenchmark) {
    const dbInitStmt = runBenchmark.getVariableStatementOrThrow(stmt => stmt.getText().includes("getDb(config.dbPath)"));
    dbInitStmt.replaceWithText("await initKuzuDb(config.dbPath);\n  const conn = await getKuzuConn();");
    
    const runMigrationsStmt = runBenchmark.getStatementByKind(SyntaxKind.ExpressionStatement)?.getFirstChildByKind(SyntaxKind.CallExpression);
    if (runMigrationsStmt && runMigrationsStmt.getText().includes("runMigrations")) {
        runMigrationsStmt.getParent().remove();
    }
}

// 3. Make all db.* calls await and pass conn.
// Also fix snake_case to camelCase for returned objects.
// Let's do a global replace for simple property names.
let text = sourceFile.getFullText();

text = text.replace(/db\.getFilesByRepoLite\(([^)]+)\)/g, 'await db.getFilesByRepoLite(conn, $1)');
text = text.replace(/db\.getSymbolsByFileLite\(([^)]+)\)/g, 'await db.getSymbolsByFileLite(conn, $1)');
text = text.replace(/db\.searchSymbols\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, 'await db.searchSymbols(conn, $1, $2, $3)');
text = text.replace(/db\.getFile\(([^)]+)\)/g, 'await db.getFile(conn, $1)');
text = text.replace(/db\.getSymbol\(([^)]+)\)/g, 'await db.getSymbol(conn, $1)');
text = text.replace(/db\.getLatestVersion\(([^)]+)\)/g, 'await db.getLatestVersion(conn, $1)');
text = text.replace(/db\.getRepo\(([^)]+)\)/g, 'await db.getRepo(conn, $1)');
text = text.replace(/db\.createRepo\(/g, 'await db.upsertRepo(conn, ');

text = text.replace(/\.file_id/g, '.fileId');
text = text.replace(/\.symbol_id/g, '.symbolId');
text = text.replace(/\.rel_path/g, '.relPath');
text = text.replace(/\.version_id/g, '.versionId');

// Save the text changes and re-parse
import * as fs from 'fs';
fs.writeFileSync("scripts/real-world-benchmark.ts", text);
