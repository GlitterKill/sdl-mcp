import { DEP_LABEL_MAX_LENGTH } from "../config/constants.js";

const OPAQUE_SYMBOL_ID_PATTERN = /^[a-f0-9]{64}$/i;

export function isOpaqueSymbolIdRef(value: string): boolean {
  return OPAQUE_SYMBOL_ID_PATTERN.test(value);
}

export function pickDepLabel(targetId: string, targetName?: string): string | undefined {
  if (targetName && targetName.length > 0) {
    return targetName.length > DEP_LABEL_MAX_LENGTH
      ? targetName.slice(0, DEP_LABEL_MAX_LENGTH)
      : targetName;
  }

  if (isOpaqueSymbolIdRef(targetId)) {
    return undefined;
  }

  return targetId.length > DEP_LABEL_MAX_LENGTH
    ? targetId.slice(0, DEP_LABEL_MAX_LENGTH)
    : targetId;
}
