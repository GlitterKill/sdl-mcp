/**
 * Thin JSON Schemas for gateway tools — these are the schemas sent in
 * tools/list responses. They are intentionally minimal to save tokens.
 *
 * Full validation happens in the router via the strict Zod schemas.
 * These thin schemas just tell the LLM what fields are available.
 */

import {
  QUERY_ACTIONS,
  CODE_ACTIONS,
  REPO_ACTIONS,
  AGENT_ACTIONS,
} from "./schemas.js";

type ThinSchema = Record<string, unknown>;

function buildThinSchema(
  actions: readonly string[],
  options?: { repoIdOptional?: boolean },
): ThinSchema {
  const repoIdProp = {
    type: "string" as const,
    minLength: 1,
  };
  const required = options?.repoIdOptional
    ? ["action"]
    : ["action", "repoId"];

  return {
    type: "object",
    properties: {
      repoId: repoIdProp,
      action: {
        type: "string",
        enum: [...actions],
      },
    },
    required,
    // Allow action-specific params to pass through
    additionalProperties: true,
  };
}

export const QUERY_THIN_SCHEMA = buildThinSchema(QUERY_ACTIONS);
export const CODE_THIN_SCHEMA = buildThinSchema(CODE_ACTIONS);
export const REPO_THIN_SCHEMA = buildThinSchema(REPO_ACTIONS);
export const AGENT_THIN_SCHEMA = buildThinSchema(AGENT_ACTIONS);
