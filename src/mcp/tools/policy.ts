import {
  PolicyGetRequestSchema,
  PolicyGetResponse,
  PolicySetRequestSchema,
  PolicySetResponse,
} from "../tools.js";
import * as db from "../../db/queries.js";
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

  const repo = db.getRepo(repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const appConfig = loadConfig();
  const configJson = JSON.parse(repo.config_json);
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

  const repo = db.getRepo(repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const appConfig = loadConfig();
  const configJson = JSON.parse(repo.config_json);
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

  db.updateRepo(repoId, {
    config_json: JSON.stringify(configJson),
  });

  return {
    ok: true,
    repoId,
  };
}
