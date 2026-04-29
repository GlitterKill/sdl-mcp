import type { Migration } from "./types.js";
import { DatabaseError } from "../../domain/errors.js";

/**
 * Base schema version — the version that createSchema() produces for
 * fresh databases. Migrations start at BASE_SCHEMA_VERSION + 1.
 */
export const BASE_SCHEMA_VERSION = 4;

// Import migrations here as they are added:
import * as m005 from "./m005-add-memory-system.js";
import * as m006 from "./m006-add-usage-snapshot.js";
import * as m007 from "./m007-copy-embeddings-to-symbol.js";
import * as m008 from "./m008-add-entity-searchtext.js";
import * as m009 from "./m009-add-symbol-summary-metadata.js";
import * as m010 from "./m010-add-jina-code-embedding.js";
import * as m011 from "./m011-add-centrality-and-shadow-clusters.js";
import * as m012 from "./m012-add-symbol-repo-id-for-algo-projections.js";
import * as m013 from "./m013-semantic-vector-array-storage.js";
import * as m014 from "./m014-add-packed-stats.js";
import * as m015 from "./m015-backfill-packed-stats.js";

/** Ordered list of all migrations. Must be sorted by version ascending. */
export const migrations: Migration[] = [
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
  m015,
];

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
