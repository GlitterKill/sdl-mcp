import { z } from "zod";

/** Static request contract for the compact retrieve surface. */
export const RetrieveOpSchema = z.enum([
  "symbolSearch",
  "symbolGetCard",
  "sliceBuild",
  "codeSkeleton",
  "codeHotPath",
  "codeNeedWindow",
]);

export const RetrieveRequestSchema = z.object({
  repoId: z.string().min(1),
  op: RetrieveOpSchema,
  args: z.record(z.string(), z.unknown()).optional().default({}),
  responseMode: z.enum(["inline", "auto", "handle"]).optional(),
});

export type RetrieveOp = z.infer<typeof RetrieveOpSchema>;
