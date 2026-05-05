import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const schemaPath = join(repoRoot, "src", "db", "ladybug-schema.ts");
const migrationsDir = join(repoRoot, "src", "db", "migrations");

function extractNodeTables(source) {
  const tables = new Map();
  const tableRe =
    /CREATE NODE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)/g;
  for (const match of source.matchAll(tableRe)) {
    const [, tableName, body] = match;
    const columns = new Set();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      const column = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/)?.[1];
      if (column) columns.add(column);
    }
    tables.set(tableName, columns);
  }
  return tables;
}

function extractMigrationAlters(source) {
  const alters = [];
  const alterRe =
    /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi;
  for (const match of source.matchAll(alterRe)) {
    alters.push({ table: match[1], column: match[2] });
  }
  return alters;
}

const schemaSource = readFileSync(schemaPath, "utf8");
const nodeTables = extractNodeTables(schemaSource);
const failures = [];

for (const fileName of readdirSync(migrationsDir).sort()) {
  if (!/^m0.*\.ts$/.test(fileName)) continue;
  const migrationPath = join(migrationsDir, fileName);
  const migrationSource = readFileSync(migrationPath, "utf8");
  for (const { table, column } of extractMigrationAlters(migrationSource)) {
    const baseColumns = nodeTables.get(table);
    if (!baseColumns) {
      failures.push(
        `${basename(migrationPath)}: ALTER TABLE ${table} ADD ${column} but NODE_TABLES has no ${table} table`,
      );
      continue;
    }
    if (!baseColumns.has(column)) {
      failures.push(
        `${basename(migrationPath)}: ALTER TABLE ${table} ADD ${column} but NODE_TABLES.${table} is missing ${column}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("[schema-sync] Base schema is missing migration-added columns:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("[schema-sync] Base schema includes all migration-added columns.");
