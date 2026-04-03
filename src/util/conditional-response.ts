import { hashValue } from "./hashing.js";

export interface ConditionalNotModifiedResponse {
  notModified: true;
  etag: string;
}

/**
 * Build a payload with a deterministic ETag and short-circuit when the caller
 * already has the same version.
 */
export function buildConditionalResponse<
  TPayload extends object,
  TMeta extends Record<string, unknown> = Record<string, never>,
>(
  payload: TPayload,
  options: {
    ifNoneMatch?: string;
    stableValue?: unknown;
    notModifiedMeta?: TMeta;
  } = {},
): (TPayload & { etag: string }) | (ConditionalNotModifiedResponse & TMeta) {
  const etag = hashValue(options.stableValue ?? payload);

  if (options.ifNoneMatch && options.ifNoneMatch === etag) {
    return {
      notModified: true,
      etag,
      ...(options.notModifiedMeta ?? ({} as TMeta)),
    };
  }

  return {
    ...payload,
    etag,
  };
}
