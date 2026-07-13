/**
 * policy/ barrel — public API of the Policy module.
 *
 * Consumer surface — decision module entry points:
 *   - `decideCodeAccess` for codeWindow / skeleton / hotPath / symbolCard / graphSlice / delta
 *   - `decideRuntime` for runtime execution
 *
 * `toLegacyPolicyDecision` is a compatibility serializer for existing
 * telemetry and error payloads; it does not evaluate policy. New code should
 * consume the discriminated decision shape directly.
 *
 * The `PolicyEngine` class is no longer re-exported from the barrel.
 * The few remaining tests that exercise it directly import from
 * `./engine.js` (deep import). Production code goes through the
 * decision functions above.
 */

export {
  decideCodeAccess,
  toLegacyPolicyDecision,
} from "./code-access.js";
export type {
  CodeAccessDecision,
  CodeAccessApprove,
  CodeAccessDowngrade,
  CodeAccessDeny,
  EffectiveCaps,
  CapDenialSuggestions,
} from "./code-access.js";

export { decideRuntime } from "./runtime.js";
export type {
  RuntimeDecision,
  RuntimeApprove,
  RuntimeDeny,
} from "./runtime.js";

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
