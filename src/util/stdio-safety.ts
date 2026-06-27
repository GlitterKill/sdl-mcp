export function isBrokenPipeError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

export function safeWriteStderr(message: string): boolean {
  if (process.stderr.destroyed || process.stderr.writableEnded) {
    return false;
  }
  try {
    return process.stderr.write(message);
  } catch (error) {
    if (!isBrokenPipeError(error)) throw error;
    return false;
  }
}
