import { withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { parseUnresolvedCallTarget } from "../../db/symbol-placeholders.js";

import { isBuiltinCall } from "./builtins.js";

export async function cleanupUnresolvedEdges(
  repoId: string,
  options: {
    onPlannedTargetCleanup?: (symbolIds: readonly string[]) => void;
  } = {},
): Promise<void> {
  await withWriteConn(async (wConn) => {
    const targetIds = await ladybugDb.getUnresolvedCallTargetIdsByRepo(
      wConn,
      repoId,
    );
    const targetsToDelete = targetIds.filter((targetId) => {
      const rawTarget = parseUnresolvedCallTarget(targetId) ?? "";
      const lastIdentifier = rawTarget.split(".").pop() ?? rawTarget;
      return isBuiltinCall(lastIdentifier);
    });

    if (targetsToDelete.length === 0) {
      return;
    }

    options.onPlannedTargetCleanup?.(targetsToDelete);
    await ladybugDb.withTransaction(wConn, async (txConn) => {
      await ladybugDb.deleteCallEdgesToTargetsByRepo(
        txConn,
        repoId,
        targetsToDelete,
      );
    });
  });
}

