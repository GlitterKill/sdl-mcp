import type { Migration } from "./types.js";
import { DatabaseError } from "../../domain/errors.js";

/**
 * Base schema version — the version that createSchema() produces for
 * fresh databases. Migrations start at BASE_SCHEMA_VERSION + 1.
 */
export const BASE_SCHEMA_VERSION = 4;

// Import migrations here as they are added:
import * as m005 from "./m005-add-memory-system.js";

/** Ordered list of all migrations. Must be sorted by version ascending. */
export const migrations: Migration[] = [m005];

// --- Registry validation (runs at import time) ---
function validateMigrations(migs: Migration[]): void {
  for (let i = 0; i < migs.length; i++) {
    const m = migs[i];
    const expectedVersion = BASE_SCHEMA_VERSION + 1 + i;
    if (m.version !== expectedVersion) {
      throw new DatabaseError(
        `Migration registry error: expected version ${expectedVersion} at index ${i}, ` +
          `got ${m.version} ("${m.description}"). Versions must be sequential starting at ${BASE_SCHEMA_VERSION + 1}.`,
      );
    }
  }
}

validateMigrations(migrations);

/**
 * The latest schema version. Derived from the registry so there is
 * no separate constant to keep in sync.
 */
export const LADYBUG_SCHEMA_VERSION: number =
  migrations.length > 0
    ? migrations[migrations.length - 1].version
    : BASE_SCHEMA_VERSION;

export type { Migration } from "./types.js";
