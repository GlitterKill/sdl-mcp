import Database from "better-sqlite3";
import { join } from "path";
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
  const db = new Database(path);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  db.pragma("foreign_keys = ON");

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
