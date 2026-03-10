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
  let configJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(repo.configJson);
    configJson =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    throw new DatabaseError(
      `Repository ${repoId} has corrupt configJson in database`,
    );
  }
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

  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const appConfig = loadConfig();
  let configJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(repo.configJson);
    configJson =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    throw new DatabaseError(
      `Repository ${repoId} has corrupt configJson in database`,
    );
  }
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

  await withWriteConn(async (wConn) => {
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
