import { z } from "zod";

export const ProjectionRequestOptionShape = {
  detail: z
    .enum(["compact", "standard", "full"])
    .optional()
    .describe("Model-facing response detail."),
  includeDiagnostics: z
    .boolean()
    .optional()
    .describe("Include diagnostic fields in the model-facing response."),
};

export const ProjectionRequestOptionsSchema = z.object(
  ProjectionRequestOptionShape,
);

type PublicProjectionRequestOptions = z.input<
  typeof ProjectionRequestOptionsSchema
>;
type ProjectionOptionKey = keyof PublicProjectionRequestOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inputSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodPipe) {
    return inputSchema(schema.def.in as z.ZodType);
  }
  return schema;
}

function schemaOwnsOption(
  schema: z.ZodType,
  key: ProjectionOptionKey,
): boolean {
  const input = inputSchema(schema);
  if (input instanceof z.ZodObject) {
    return Object.hasOwn(input.shape, key);
  }
  if (input instanceof z.ZodIntersection) {
    return (
      schemaOwnsOption(input.def.left as z.ZodType, key)
      || schemaOwnsOption(input.def.right as z.ZodType, key)
    );
  }
  if (input instanceof z.ZodDiscriminatedUnion) {
    return input.options.some((option) =>
      schemaOwnsOption(option as z.ZodType, key),
    );
  }
  return false;
}

function extendProjectionInput(schema: z.ZodType): z.ZodType {
  const input = inputSchema(schema);
  if (input instanceof z.ZodObject) {
    return input.safeExtend({
      ...(Object.hasOwn(input.shape, "detail")
        ? {}
        : { detail: ProjectionRequestOptionShape.detail }),
      ...(Object.hasOwn(input.shape, "includeDiagnostics")
        ? {}
        : {
            includeDiagnostics: ProjectionRequestOptionShape.includeDiagnostics,
          }),
    });
  }
  if (input instanceof z.ZodIntersection) {
    return z.intersection(
      extendProjectionInput(input.def.left as z.ZodType),
      extendProjectionInput(input.def.right as z.ZodType),
    );
  }
  if (input instanceof z.ZodDiscriminatedUnion) {
    const options = input.options.map((option) => {
      const extended = extendProjectionInput(option as z.ZodType);
      if (!(extended instanceof z.ZodObject)) {
        throw new Error("Projection options require object union variants");
      }
      return extended;
    }) as [z.ZodObject, ...z.ZodObject[]];
    return z.discriminatedUnion(input.def.discriminator, options);
  }
  throw new Error(
    "Projection options require an object, object pipe, discriminated union, or intersection schema",
  );
}

/**
 * Adds the public projection fields to a request schema while preserving its
 * domain output. Fields already owned by the domain remain available to the
 * handler; projection-only fields are validated and removed before domain
 * parsing.
 */
export function withProjectionRequestOptions<T extends z.ZodType>(
  schema: T,
): z.ZodType<z.output<T>, z.input<T> & PublicProjectionRequestOptions>;
export function withProjectionRequestOptions(schema: z.ZodType): z.ZodType {
  const ownsDetail = schemaOwnsOption(schema, "detail");
  const ownsDiagnostics = schemaOwnsOption(schema, "includeDiagnostics");
  const publicInput = extendProjectionInput(schema);

  return publicInput
    .transform((value) => {
      if (!isRecord(value)) return value;
      const domainInput = { ...value };
      if (!ownsDetail) delete domainInput.detail;
      if (!ownsDiagnostics) delete domainInput.includeDiagnostics;
      return domainInput;
    })
    .pipe(schema);
}

function requestOptionJsonProperties(
  schema: z.ZodType,
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" });
  return isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
}

/**
 * Adds shared fields to a manually-authored MCP wire schema. Projection
 * properties come from the registered Zod request schema, falling back to the
 * shared option schema, so JSON and runtime validation cannot drift.
 */
export function withProjectionRequestOptionsJsonSchema<
  T extends Record<string, unknown>,
>(
  schema: T,
  requestSchema: z.ZodType,
): T & { properties: Record<string, unknown> } {
  const record: Record<string, unknown> = { ...schema };
  const properties = isRecord(record.properties) ? record.properties : {};
  const sharedProperties = requestOptionJsonProperties(
    ProjectionRequestOptionsSchema,
  );
  const requestProperties = requestOptionJsonProperties(requestSchema);
  const detail = requestProperties.detail ?? sharedProperties.detail;
  const includeDiagnostics =
    requestProperties.includeDiagnostics ?? sharedProperties.includeDiagnostics;

  if (!detail || !includeDiagnostics) {
    throw new Error("Projection option JSON schema properties are missing");
  }

  return {
    ...schema,
    properties: {
      ...properties,
      detail: properties.detail ?? detail,
      includeDiagnostics: properties.includeDiagnostics ?? includeDiagnostics,
    },
  };
}
