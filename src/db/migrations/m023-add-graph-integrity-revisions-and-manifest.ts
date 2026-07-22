import type { Connection } from "kuzu";

import { exec, execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

export const version = 23;
export const description =
  "Add graph integrity revisions and persisted manifest state";

const DDL = [
  "ALTER TABLE DerivedState ADD graphIntegrityRevision INT64 DEFAULT NULL",
  "ALTER TABLE DerivedState ADD graphIntegrityVerifiedRevision INT64 DEFAULT NULL",
  "ALTER TABLE DerivedState ADD graphIntegrityFilelessPruningSupported BOOLEAN DEFAULT NULL",
  "ALTER TABLE DerivedState ADD graphIntegrityManifestEstablished BOOLEAN DEFAULT false",
  `CREATE NODE TABLE IF NOT EXISTS GraphIntegrityFileState (
    stateId STRING PRIMARY KEY,
    repoId STRING,
    fileId STRING,
    relPath STRING,
    symbolCount INT64,
    digest STRING,
    filelessReferencesJson STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS GraphIntegrityFilelessState (
    stateId STRING PRIMARY KEY,
    repoId STRING,
    symbolId STRING,
    canonicalSymbolJson STRING,
    referenceCount INT64
  )`,
  `CREATE REL TABLE IF NOT EXISTS GRAPH_INTEGRITY_FILE_STATE_IN_REPO (
    FROM GraphIntegrityFileState TO Repo
  )`,
  `CREATE REL TABLE IF NOT EXISTS GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO (
    FROM GraphIntegrityFilelessState TO Repo
  )`,
];

export async function up(conn: Connection): Promise<void> {
  for (const ddl of DDL) {
    try {
      await execDdl(conn, ddl);
    } catch (error) {
      // Partial DDL may survive a failed migration transaction; reruns skip it.
      const message = error instanceof Error ? error.message : String(error);
      if (!IDEMPOTENT_DDL_ERROR_RE.test(message)) throw error;
    }
  }
  await exec(
    conn,
    `MATCH (d:DerivedState)
     SET d.graphIntegrityState = 'unknown',
         d.graphIntegrityRevision = NULL,
         d.graphIntegrityVerifiedRevision = NULL,
         d.graphIntegrityFilelessPruningSupported = NULL,
         d.graphIntegrityManifestEstablished = false`,
  );
}
