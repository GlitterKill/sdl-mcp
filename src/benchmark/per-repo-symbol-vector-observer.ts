import { AsyncLocalStorage } from "node:async_hooks";
import { fstatSync, fsyncSync, readSync, writeSync } from "node:fs";

import type { IndexProgress } from "../indexer/indexer.js";

export const PER_REPO_SYMBOL_VECTOR_TRACE_MARKER =
  "SDL_MCP_PER_REPO_SYMBOL_VECTOR_TRACE_V1\n";
export const MAX_PER_REPO_SYMBOL_VECTOR_TRACE_BYTES =
  16 * 1_024 * 1_024;
export const PER_REPO_SYMBOL_VECTOR_TRACE_TERMINAL_RESERVE_BYTES = 1_024;

interface RepositoryVectorIdentityEvent {
  repoId: string;
  model: string;
  tableName: string;
  propertyName: string;
  indexName: string;
  completeCount: number;
}

export type PerRepoSymbolVectorEventInput =
  | {
      type: "progress";
      repoId: string;
      progress: IndexProgress;
    }
  | ({ type: "hnsw-start" } & RepositoryVectorIdentityEvent)
  | ({
      type: "hnsw-end";
      success: boolean;
    } & RepositoryVectorIdentityEvent)
  | ({ type: "embedding-complete" } & RepositoryVectorIdentityEvent)
  | {
      type: "process-end";
      success: boolean;
      maxRssBytes: number;
    };

export type PerRepoSymbolVectorEvent = PerRepoSymbolVectorEventInput & {
  schemaVersion: 1;
  sequence: number;
  monotonicNs: string;
};

interface ObserverState {
  sequence: number;
  sink: (event: PerRepoSymbolVectorEvent) => void;
}

type PositionalWriter = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => number;

const observer = new AsyncLocalStorage<ObserverState>();

/** @internal Writes every byte at an explicit file position or fails closed. */
export function writeAllAt(
  fd: number,
  buffer: Buffer,
  position: number,
  writer: PositionalWriter = writeSync,
): number {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const written = writer(fd, buffer, offset, remaining, position + offset);
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Error("Repository vector trace write made no progress");
    }
    offset += written;
  }
  return position + offset;
}

/**
 * @internal Activates only for a fresh regular trace file carrying the exact
 * private marker. JSONL starts immediately after the marker.
 */
export function openPerRepoSymbolVectorTraceSink(
  fd = 3,
): ((event: PerRepoSymbolVectorEvent) => void) | null {
  const marker = Buffer.from(PER_REPO_SYMBOL_VECTOR_TRACE_MARKER, "utf8");
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size !== marker.length) return null;

    const actual = Buffer.alloc(marker.length);
    let offset = 0;
    while (offset < actual.length) {
      const read = readSync(fd, actual, offset, actual.length - offset, offset);
      if (read === 0) return null;
      offset += read;
    }
    if (!actual.equals(marker)) return null;
  } catch {
    return null;
  }

  let writtenBytes = marker.length;
  return (event) => {
    const eventBuffer = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const terminal = event.type === "process-end";
    const writeLimit = terminal
      ? MAX_PER_REPO_SYMBOL_VECTOR_TRACE_BYTES
      : MAX_PER_REPO_SYMBOL_VECTOR_TRACE_BYTES -
        PER_REPO_SYMBOL_VECTOR_TRACE_TERMINAL_RESERVE_BYTES;
    if (
      (terminal &&
        eventBuffer.length >
          PER_REPO_SYMBOL_VECTOR_TRACE_TERMINAL_RESERVE_BYTES) ||
      writtenBytes + eventBuffer.length > writeLimit
    ) {
      throw new Error("Repository vector trace byte limit exceeded");
    }

    writtenBytes = writeAllAt(fd, eventBuffer, writtenBytes);
    if (terminal) fsyncSync(fd);
  };
}

/** @internal Private benchmark observer; absent outside the trace-file scope. */
export function emitPerRepoSymbolVectorEvent(
  event: PerRepoSymbolVectorEventInput,
): boolean {
  const state = observer.getStore();
  if (!state) return false;

  const sequence = state.sequence + 1;
  state.sink({
    ...event,
    schemaVersion: 1,
    sequence,
    monotonicNs: process.hrtime.bigint().toString(),
  });
  state.sequence = sequence;
  return true;
}

/** @internal Runs one direct CLI command inside a sequenced benchmark scope. */
export function withPerRepoSymbolVectorObserver<T>(
  sink: (event: PerRepoSymbolVectorEvent) => void,
  operation: () => Promise<T>,
): Promise<T> {
  return observer.run({ sequence: 0, sink }, operation);
}

/** @internal Emits and flushes one terminal process event on success or failure. */
export function withPerRepoSymbolVectorProcessTrace<T>(
  sink: (event: PerRepoSymbolVectorEvent) => void,
  operation: () => Promise<T>,
): Promise<T> {
  return withPerRepoSymbolVectorObserver(sink, async () => {
    let success = false;
    try {
      const result = await operation();
      success = true;
      return result;
    } finally {
      emitPerRepoSymbolVectorEvent({
        type: "process-end",
        success,
        maxRssBytes: process.resourceUsage().maxRSS * 1_024,
      });
    }
  });
}
