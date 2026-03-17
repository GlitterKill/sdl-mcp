/**
 * policy/ barrel — re-exports the public API of the Policy Engine.
 *
 * Consumers MAY import from individual files for narrower deps.
 */

export { PolicyEngine } from "./engine.js";

export { DEFAULT_POLICY_CONFIG } from "./types.js";
export type {
  PolicyRequestType,
  PolicyRequestContext,
  PolicyEvidence,
  PolicyRule,
  PolicyDecision,
  PolicyConfig,
  RuntimePolicyRequestContext,
  RuntimePolicyDecision,
} from "./types.js";
