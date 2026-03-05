import {
  PolicyGetRequestSchema,
  PolicyGetResponse,
  PolicySetRequestSchema,
  PolicySetResponse,
} from "../tools.js";
import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";
import { PolicyConfigSchema } from "../../config/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { DatabaseError } from "../errors.js";

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

  const conn = await getKuzuConn();
  const repo = await kuzuDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const appConfig = loadConfig();
  const configJson = JSON.parse(repo.configJson);
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

  const conn = await getKuzuConn();
  const repo = await kuzuDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const appConfig = loadConfig();
  const configJson = JSON.parse(repo.configJson);
  const existingPolicyOverrides =
    configJson.policy && typeof configJson.policy === "object"
      ? configJson.policy
      : {};
  const mergedOverrides = { ...existingPolicyOverrides, ...policyPatch };
  PolicyConfigSchema.parse({
    ...appConfig.policy,
    ...mergedOverrides,
  });
  configJson.policy = mergedOverrides;

  await kuzuDb.upsertRepo(conn, {
    repoId,
    rootPath: repo.rootPath,
    configJson: JSON.stringify(configJson),
    createdAt: repo.createdAt,
  });

  return {
    ok: true,
    repoId,
  };
}
