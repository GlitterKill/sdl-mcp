import type { Connection } from "kuzu";

import { remediateSymbolEmbeddings } from "./symbol-embedding-remediation.js";

export const version = 21;
export const description =
  "Safely remediate residual SymbolEmbedding compatibility rows";

export async function up(conn: Connection): Promise<void> {
  await remediateSymbolEmbeddings(conn, "m021");
}
