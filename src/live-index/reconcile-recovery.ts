import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { z } from "zod";

const RecoveryPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !posix.isAbsolute(path) &&
      !win32.parse(path).root &&
      !path.includes("\0") &&
      !path.split(/[\\/]/).includes(".."),
    "Recovery paths must stay relative to the repository",
  );

const RecoverySchema = z.object({
  version: z.literal(1),
  repos: z.array(
    z.object({
      repoId: z.string().min(1),
      filePaths: z.array(RecoveryPathSchema).max(10_000),
      touchedSymbolIds: z.array(z.string()).max(10_000),
      invalidations: z.array(z.enum(["metrics", "clusters", "processes"])),
      inventoryNeeded: z.boolean(),
      inventoryForce: z.boolean(),
    }),
  ),
});
export type ReconcileRecovery = z.infer<typeof RecoverySchema>;

/** This sidecar belongs to the database, so different graph databases never share work. */
export async function readReconcileRecovery(
  path: string,
): Promise<ReconcileRecovery> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, repos: [] };
    throw error;
  }
  try {
    // Bound local checkpoint reads before parsing; never silently discard invalid recovery.
    const maxBytes = 16 * 1024 * 1024;
    const data = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(
        data,
        length,
        data.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes)
      throw new Error("Reconciliation checkpoint exceeds 16 MiB");
    return RecoverySchema.parse(
      JSON.parse(data.subarray(0, length).toString("utf8")),
    );
  } finally {
    await file.close();
  }
}

/** Replace only after fsync; a failed checkpoint must prevent graceful DB close. */
export async function writeReconcileRecovery(
  path: string,
  state: ReconcileRecovery,
): Promise<void> {
  const content = JSON.stringify(RecoverySchema.parse(state));
  if (Buffer.byteLength(content) > 16 * 1024 * 1024)
    throw new Error("Reconciliation checkpoint exceeds 16 MiB");
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    // Directory fsync is unsupported on Windows; the file itself is already durable.
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
