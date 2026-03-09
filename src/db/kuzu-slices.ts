/**
 * kuzu-slices.ts — Slice Handle Operations
 * Extracted from kuzu-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import { exec, queryAll, querySingle } from "./kuzu-core.js";

export interface SliceHandleRow {
  handle: string;
  repoId: string;
  createdAt: string;
  expiresAt: string;
  minVersion: string | null;
  maxVersion: string | null;
  sliceHash: string;
  spilloverRef: string | null;
}

export async function upsertSliceHandle(
  conn: Connection,
  handle: SliceHandleRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (h:SliceHandle {handle: $handle})
     SET h.repoId = $repoId,
         h.createdAt = $createdAt,
         h.expiresAt = $expiresAt,
         h.minVersion = $minVersion,
         h.maxVersion = $maxVersion,
         h.sliceHash = $sliceHash,
         h.spilloverRef = $spilloverRef`,
    {
      handle: handle.handle,
      repoId: handle.repoId,
      createdAt: handle.createdAt,
      expiresAt: handle.expiresAt,
      minVersion: handle.minVersion,
      maxVersion: handle.maxVersion,
      sliceHash: handle.sliceHash,
      spilloverRef: handle.spilloverRef,
    },
  );
}

export async function getSliceHandle(
  conn: Connection,
  handle: string,
): Promise<SliceHandleRow | null> {
  const row = await querySingle<SliceHandleRow>(
    conn,
    `MATCH (h:SliceHandle {handle: $handle})
     RETURN h.handle AS handle,
            h.repoId AS repoId,
            h.createdAt AS createdAt,
            h.expiresAt AS expiresAt,
            h.minVersion AS minVersion,
            h.maxVersion AS maxVersion,
            h.sliceHash AS sliceHash,
            h.spilloverRef AS spilloverRef`,
    { handle },
  );
  return row ?? null;
}

export async function deleteExpiredSliceHandles(
  conn: Connection,
  beforeTimestamp: string,
): Promise<number> {
  const rows = await queryAll<{ handle: string }>(
    conn,
    `MATCH (h:SliceHandle)
     WHERE h.expiresAt < $beforeTimestamp
     RETURN h.handle AS handle`,
    { beforeTimestamp },
  );

  for (const row of rows) {
    await exec(
      conn,
      `MATCH (h:SliceHandle {handle: $handle})
       DELETE h`,
      { handle: row.handle },
    );
  }

  return rows.length;
}

export async function updateSliceHandleSpillover(
  conn: Connection,
  handle: string,
  spilloverRef: string | null,
): Promise<void> {
  await exec(
    conn,
    `MATCH (h:SliceHandle {handle: $handle})
     SET h.spilloverRef = $spilloverRef`,
    { handle, spilloverRef },
  );
}

export interface CardHashRow {
  cardHash: string;
  cardBlob: string;
  createdAt: string;
}

export async function upsertCardHash(
  conn: Connection,
  row: CardHashRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (c:CardHash {cardHash: $cardHash})
     SET c.cardBlob = $cardBlob,
         c.createdAt = $createdAt`,
    {
      cardHash: row.cardHash,
      cardBlob: row.cardBlob,
      createdAt: row.createdAt,
    },
  );
}

export async function getCardHash(
  conn: Connection,
  cardHash: string,
): Promise<CardHashRow | null> {
  const row = await querySingle<CardHashRow>(
    conn,
    `MATCH (c:CardHash {cardHash: $cardHash})
     RETURN c.cardHash AS cardHash,
            c.cardBlob AS cardBlob,
            c.createdAt AS createdAt`,
    { cardHash },
  );
  return row ?? null;
}

