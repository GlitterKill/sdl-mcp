import type { Connection } from "kuzu";

import { querySingle, toNumber } from "./ladybug-core.js";

/** Count a validated node table used by index lifecycle decisions. */
export async function countRowsInNodeTable(
  conn: Connection,
  tableName: string,
): Promise<number> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new Error(
      `Invalid table name: ${JSON.stringify(tableName)} - must be an alphanumeric identifier`,
    );
  }
  const row = await querySingle<{ rowCount: unknown }>(
    conn,
    `MATCH (n:${tableName}) RETURN COUNT(n) AS rowCount`,
  );
  return toNumber(row?.rowCount ?? 0);
}
