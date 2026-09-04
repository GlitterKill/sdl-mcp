import type { Connection } from "kuzu";

import { SafeRebuildRequiredError } from "../../domain/errors.js";

export const version = 27;
export const description =
  "Require a safe rebuild for per-repository Symbol vector tables";
export const requiresFreshDatabase = true;

export async function up(_conn: Connection): Promise<void> {
  throw new SafeRebuildRequiredError(
    "Schema 27 changes the physical Symbol vector layout and cannot be applied in place.",
  );
}
