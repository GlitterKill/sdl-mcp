/**
 * ladybug-config.ts - Tool Policy and Tsconfig Hash Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import { exec, querySingle } from "./ladybug-core.js";

export interface ToolPolicyHashRow {
  policyHash: string;
  policyBlob: string;
  createdAt: string;
}

export async function upsertToolPolicyHash(
  conn: Connection,
  row: ToolPolicyHashRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (p:ToolPolicyHash {policyHash: $policyHash})
     SET p.policyBlob = $policyBlob,
         p.createdAt = $createdAt`,
    {
      policyHash: row.policyHash,
      policyBlob: row.policyBlob,
      createdAt: row.createdAt,
    },
  );
}

export async function getToolPolicyHash(
  conn: Connection,
  policyHash: string,
): Promise<ToolPolicyHashRow | null> {
  const row = await querySingle<ToolPolicyHashRow>(
    conn,
    `MATCH (p:ToolPolicyHash {policyHash: $policyHash})
     RETURN p.policyHash AS policyHash,
            p.policyBlob AS policyBlob,
            p.createdAt AS createdAt`,
    { policyHash },
  );
  return row ?? null;
}

export interface TsconfigHashRow {
  tsconfigHash: string;
  tsconfigBlob: string;
  createdAt: string;
}

export async function upsertTsconfigHash(
  conn: Connection,
  row: TsconfigHashRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (t:TsconfigHash {tsconfigHash: $tsconfigHash})
     SET t.tsconfigBlob = $tsconfigBlob,
         t.createdAt = $createdAt`,
    {
      tsconfigHash: row.tsconfigHash,
      tsconfigBlob: row.tsconfigBlob,
      createdAt: row.createdAt,
    },
  );
}

export async function getTsconfigHash(
  conn: Connection,
  tsconfigHash: string,
): Promise<TsconfigHashRow | null> {
  const row = await querySingle<TsconfigHashRow>(
    conn,
    `MATCH (t:TsconfigHash {tsconfigHash: $tsconfigHash})
     RETURN t.tsconfigHash AS tsconfigHash,
            t.tsconfigBlob AS tsconfigBlob,
            t.createdAt AS createdAt`,
    { tsconfigHash },
  );
  return row ?? null;
}
