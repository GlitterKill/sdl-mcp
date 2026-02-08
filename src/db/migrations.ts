import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { findPackageRoot } from "../util/findPackageRoot.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = findPackageRoot(__dirname);
const MIGRATIONS_DIR = join(PACKAGE_ROOT, "migrations");

export interface MigrationRow {
  id: number;
  name: string;
  applied_at: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

function registerMigrationFunctions(db: Database.Database): void {
  // SQLite does not ship with reverse() by default, but migration 0011 uses it.
  db.function(
    "reverse",
    { deterministic: true },
    (value: string | null): string | null => {
      if (value === null) {
        return null;
      }
      return [...value].reverse().join("");
    },
  );
}

export function getAppliedMigrations(db: Database.Database): MigrationRow[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);

  return db
    .prepare("SELECT * FROM _migrations ORDER BY name")
    .all() as MigrationRow[];
}

export function getPendingMigrations(db: Database.Database): string[] {
  const appliedMigrations = getAppliedMigrations(db);
  const appliedNames = new Set(appliedMigrations.map((m) => m.name));

  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  return migrationFiles.filter((f) => !appliedNames.has(f));
}

export function runMigrations(db: Database.Database): MigrationResult {
  registerMigrationFunctions(db);

  const appliedMigrations = getAppliedMigrations(db);
  const appliedNames = new Set(appliedMigrations.map((m) => m.name));

  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const insertStmt = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)"
  );

  const result: MigrationResult = {
    applied: [],
    alreadyApplied: []
  };

  for (const file of migrationFiles) {
    if (appliedNames.has(file)) {
      result.alreadyApplied.push(file);
      continue;
    }

    const filePath = join(MIGRATIONS_DIR, file);
    const sql = readFileSync(filePath, "utf-8");

    try {
      db.exec(sql);
    } catch (error) {
      // Handle idempotency issues: if the schema change already exists, mark as applied
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isIdempotencyError =
        errorMessage.includes("duplicate column name") ||
        errorMessage.includes("already exists") ||
        (errorMessage.includes("table") && errorMessage.includes("already exists"));

      if (!isIdempotencyError) {
        throw error;
      }
      // Schema change already applied, continue to mark as applied
    }

    const now = new Date().toISOString();
    insertStmt.run(file, now);
    result.applied.push(file);
  }

  return result;
}

import { getDb } from "./db.js";

export function runDefaultMigrations(): void {
  const db = getDb();
  runMigrations(db);
}
