export interface LocalEmbeddingRuntime {
  available: boolean;
  reason?: string;
}

let cachedRuntime: LocalEmbeddingRuntime | null = null;

export async function ensureLocalEmbeddingRuntime(): Promise<LocalEmbeddingRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  try {
    // Keep this import runtime-only so optional dependency absence does not fail typecheck.
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<unknown>;
    await dynamicImport("onnxruntime-node");
    cachedRuntime = { available: true };
  } catch (error) {
    cachedRuntime = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return cachedRuntime;
}
