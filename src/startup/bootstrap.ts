import type { AppConfig } from "../config/types.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import { getCurrentTimestamp } from "../util/time.js";

export async function ensureConfiguredReposRegistered(
  config: AppConfig,
  log: (message: string) => void,
): Promise<void> {
  const conn = await getLadybugConn();

  for (const repo of config.repos) {
    const existingRepo = await ladybugDb.getRepo(conn, repo.repoId);
    if (existingRepo) {
      continue;
    }

    log(`Registering repository in database: ${repo.repoId}`);
    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertRepo(wConn, {
        repoId: repo.repoId,
        rootPath: repo.rootPath,
        configJson: JSON.stringify(repo),
        createdAt: getCurrentTimestamp(),
      });
    });
  }
}
