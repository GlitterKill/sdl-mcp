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
    // Use @vite-ignore to suppress bundler static analysis warnings for optional dependency.
    await import(/* @vite-ignore */ "onnxruntime-node");
    cachedRuntime = { available: true };
  } catch (error) {
    cachedRuntime = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return cachedRuntime;
}
