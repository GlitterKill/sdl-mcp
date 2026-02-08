import Database from "better-sqlite3";
import { runMigrations, getAppliedMigrations, getPendingMigrations, MigrationResult, MigrationRow } from "../src/db/migrations.js";
import { loadConfig } from "../src/config/loadConfig.js";

interface CliArgs {
  status: boolean;
  config?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    status: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--status") {
      args.status = true;
    } else if (arg === "--config") {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        args.config = nextArg;
        i++;
      }
    }
  }

  return args;
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv);

    let dbPath: string;
    try {
      const config = loadConfig(args.config);
      dbPath = config.dbPath;
    } catch (err) {
      dbPath = "./sdl-ledger.db";
    }

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");

    if (args.status) {
      const applied = getAppliedMigrations(db);
      const pending = getPendingMigrations(db);

      console.log(`Database: ${dbPath}`);
      console.log(`\nApplied migrations: ${applied.length}`);
      for (const migration of applied) {
        console.log(`  ✓ ${migration.name} (${migration.applied_at})`);
      }

      console.log(`\nPending migrations: ${pending.length}`);
      if (pending.length === 0) {
        console.log("  (none)");
      } else {
        for (const migration of pending) {
          console.log(`  ○ ${migration}`);
        }
      }
    } else {
      const result = runMigrations(db);

      console.log(`Database: ${dbPath}`);

      if (result.applied.length === 0) {
        console.log("\nNo pending migrations to apply.");
      } else {
        console.log(`\nApplied ${result.applied.length} migration(s):`);
        for (const migration of result.applied) {
          console.log(`  ✓ ${migration}`);
        }
      }

      if (result.alreadyApplied.length > 0) {
        console.log(`\n${result.alreadyApplied.length} migration(s) already applied.`);
      }
    }

    db.close();
    process.exit(0);
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

main();
