import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DB_BUSY_TIMEOUT_MS } from "../config/constants.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let dbInstance: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const envPath = process.env.SDL_DB_PATH;
  const path =
    dbPath || envPath || join(__dirname, "..", "..", "sdl-ledger.db");

  // Ensure parent directory exists for file-backed databases (CI runners may start clean).
  if (path !== ":memory:") {
    const parentDir = dirname(path);
    if (parentDir && parentDir !== ".") {
      mkdirSync(parentDir, { recursive: true });
    }
  }

  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to open database at ${path}: ${msg}. ` +
      `Check file permissions, disk space, and that the file is not corrupted.`
    );
  }

  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    db.pragma("foreign_keys = ON");
  } catch (error) {
    db.close();
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to configure database at ${path}: ${msg}. ` +
      `The database file may be corrupted or locked by another process.`
    );
  }

  dbInstance = db;

  process.on("exit", () => {
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
    }
  });

  process.once("SIGINT", () => {
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
    }
  });

  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
