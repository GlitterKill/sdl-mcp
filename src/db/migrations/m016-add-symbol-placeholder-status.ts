import type { Connection } from "kuzu";
import { exec, execDdl, queryAll } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";
import { classifyDependencyTarget } from "../symbol-placeholders.js";

export const version = 16;
export const description =
  "Add explicit Symbol placeholder status metadata for dependency targets";

export async function up(conn: Connection): Promise<void> {
  const ddls = [
    "ALTER TABLE Symbol ADD symbolStatus STRING DEFAULT 'real'",
    "ALTER TABLE Symbol ADD placeholderKind STRING DEFAULT NULL",
    "ALTER TABLE Symbol ADD placeholderTarget STRING DEFAULT NULL",
  ];

  for (const ddl of ddls) {
    try {
      await execDdl(conn, ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (IDEMPOTENT_DDL_ERROR_RE.test(msg)) {
        continue;
      }
      throw err;
    }
  }

  await exec(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(:File)
     SET s.symbolStatus = 'real',
         s.placeholderKind = null,
         s.placeholderTarget = null`,
    {},
  );

  const unresolvedRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId STARTS WITH 'unresolved:'
     RETURN s.symbolId AS symbolId`,
    {},
  );

  for (const row of unresolvedRows) {
    const meta = classifyDependencyTarget(row.symbolId);
    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       SET s.symbolStatus = $symbolStatus,
           s.placeholderKind = $placeholderKind,
           s.placeholderTarget = $placeholderTarget`,
      {
        symbolId: row.symbolId,
        symbolStatus: meta.symbolStatus,
        placeholderKind: meta.placeholderKind,
        placeholderTarget: meta.placeholderTarget,
      },
    );
  }

  // External SCIP symbols are best-effort for upgraded DBs because older
  // schemas may not have the external/scipSymbol columns. Fresh DBs always do.
  try {
    await exec(
      conn,
      `MATCH (s:Symbol)
       WHERE s.external = true AND NOT s.symbolId STARTS WITH 'unresolved:'
       SET s.symbolStatus = 'external',
           s.placeholderKind = 'scip',
           s.placeholderTarget = CASE WHEN s.scipSymbol IS NULL THEN s.symbolId ELSE s.scipSymbol END`,
      {},
    );
  } catch {
    // Historical DBs without SCIP columns cannot have typed SCIP externals.
  }

  await exec(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolStatus IS NULL OR s.symbolStatus = ''
     SET s.symbolStatus = 'real'`,
    {},
  );
}
