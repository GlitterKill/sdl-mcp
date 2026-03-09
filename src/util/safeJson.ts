import { z, ZodSchema } from "zod";
import { DatabaseError } from "../domain/errors.js";
import { logger } from "./logger.js";

/**
 * Safely parse JSON with schema validation.
 * Returns fallback value on parse error or schema validation failure.
 * Logs warning on failure with context.
 *
 * @param raw - Raw JSON string, null, or undefined
 * @param schema - Zod schema for validation
 * @param fallback - Value to return on parse/validation failure
 * @returns Parsed and validated value, or fallback
 */
export function safeJsonParse<T>(
  raw: string | null | undefined,
  schema: ZodSchema<T>,
  fallback: T,
): T {
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = schema.parse(parsed);
    return validated;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn("JSON parse or validation failed", {
      error: errorMsg,
      input: raw.substring(0, 100), // Log first 100 chars for debugging
    });
    return fallback;
  }
}

/**
 * Safely parse JSON with schema validation.
 * Returns undefined on parse error or schema validation failure.
 *
 * @param raw - Raw JSON string, null, or undefined
 * @param schema - Zod schema for validation
 * @returns Parsed and validated value, or undefined
 */
export function safeJsonParseOptional<T>(
  raw: string | null | undefined,
  schema: ZodSchema<T>,
): T | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = schema.parse(parsed);
    return validated;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn("JSON parse or validation failed (optional)", {
      error: errorMsg,
      input: raw.substring(0, 100),
    });
    return undefined;
  }
}

/**
 * Safely parse JSON with schema validation.
 * Throws DatabaseError on parse error or schema validation failure.
 *
 * @param raw - Raw JSON string, null, or undefined
 * @param schema - Zod schema for validation
 * @param context - Context string for error message (e.g., "parsing symbol signature")
 * @returns Parsed and validated value
 * @throws DatabaseError on parse or validation failure
 */
export function safeJsonParseOrThrow<T>(
  raw: string | null | undefined,
  schema: ZodSchema<T>,
  context: string,
): T {
  if (!raw) {
    throw new DatabaseError(
      `Failed to parse JSON (${context}): input is null or undefined`,
    );
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = schema.parse(parsed);
    return validated;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Failed to parse JSON (${context}): ${errorMsg}`);
  }
}

/**
 * Schema for validating arrays of strings.
 * Used for fields like invariants, sideEffects, testRefs.
 */
export const StringArraySchema = z.array(z.string());

/**
 * Schema for validating signature JSON objects.
 * Accepts any object structure.
 * Used for fields like signatureJson.
 */
export const SignatureSchema = z.record(z.any());
