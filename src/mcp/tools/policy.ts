import {
  PolicyGetRequestSchema,
  PolicyGetResponse,
  PolicySetRequestSchema,
  PolicySetResponse,
} from "../tools.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { PolicyConfigSchema } from "../../config/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { DatabaseError } from "../errors.js";
import { safeJsonParseOrThrow, ConfigObjectSchema } from "../../util/safeJson.js";

/**
 * Handles policy retrieval requests.
 * Returns the current policy configuration for a repository.
 *
 * @param args - Raw arguments containing repoId
 * @returns Policy configuration object
 * @throws {Error} If repository not found
 */
export async function handlePolicyGet(
  args: unknown,
): Promise<PolicyGetResponse> {
  const request = PolicyGetRequestSchema.parse(args);
  const { repoId } = request;

  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const appConfig = loadConfig();
  const configJson = safeJsonParseOrThrow(repo.configJson, ConfigObjectSchema, `configJson for repository ${repoId}`);
  const repoPolicy =
    configJson.policy && typeof configJson.policy === "object"
      ? configJson.policy
      : {};
  const validatedPolicy = PolicyConfigSchema.parse({
    ...appConfig.policy,
    ...repoPolicy,
  });

  return {
    policy: validatedPolicy,
  };
}

/**
 * Handles policy update requests.
 * Merges policy patch with existing policy configuration.
 *
 * @param args - Raw arguments containing repoId and policyPatch
 * @returns Response with ok status and repoId
 * @throws {Error} If repository not found
 */
export async function handlePolicySet(
  args: unknown,
): Promise<PolicySetResponse> {
  const request = PolicySetRequestSchema.parse(args);
  const { repoId, policyPatch } = request;

  const appConfig = loadConfig();

  // The read-merge-write sequence runs entirely inside withWriteConn so it is
  // atomic under the single-writer limiter. Previously the read happened on a
  // separate read-pool connection, which allowed two concurrent policy.set
  // calls to both observe the same configJson, merge their patches
  // independently, and lose one of the updates on write.
  await withWriteConn(async (wConn) => {
    const repo = await ladybugDb.getRepo(wConn, repoId);
    if (!repo) {
      throw new DatabaseError(`Repository ${repoId} not found`);
    }

    const configJson = safeJsonParseOrThrow(
      repo.configJson,
      ConfigObjectSchema,
      `configJson for repository ${repoId}`,
    );
    const existingPolicyOverrides =
      configJson.policy && typeof configJson.policy === "object"
        ? configJson.policy
        : {};
    const validatedPatch = PolicyConfigSchema.partial().strict().parse(
      policyPatch,
    );
    const mergedOverrides = {
      ...existingPolicyOverrides,
      ...validatedPatch,
    };
    PolicyConfigSchema.parse({
      ...appConfig.policy,
      ...mergedOverrides,
    });
    configJson.policy = mergedOverrides;

    await ladybugDb.upsertRepo(wConn, {
      repoId,
      rootPath: repo.rootPath,
      configJson: JSON.stringify(configJson),
      createdAt: repo.createdAt,
    });
  });

  return {
    ok: true,
    repoId,
  };
}
