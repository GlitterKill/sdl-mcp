import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  emitPerRepoSymbolVectorEvent,
  MAX_PER_REPO_SYMBOL_VECTOR_TRACE_BYTES,
  openPerRepoSymbolVectorTraceSink,
  PER_REPO_SYMBOL_VECTOR_TRACE_MARKER,
  PER_REPO_SYMBOL_VECTOR_TRACE_TERMINAL_RESERVE_BYTES,
  withPerRepoSymbolVectorObserver,
  withPerRepoSymbolVectorProcessTrace,
  writeAllAt,
  type PerRepoSymbolVectorEvent,
} from "../../dist/benchmark/per-repo-symbol-vector-observer.js";

test("repository vector observer sequences async events inside its private scope", async () => {
  const events: PerRepoSymbolVectorEvent[] = [];

  assert.equal(
    emitPerRepoSymbolVectorEvent({
      type: "process-end",
      success: true,
      maxRssBytes: 1,
    }),
    false,
  );

  await withPerRepoSymbolVectorProcessTrace(
    (event) => events.push(event),
    async () => {
      assert.equal(
        emitPerRepoSymbolVectorEvent({
          type: "progress",
          repoId: "repo-a",
          progress: { stage: "embeddings", current: 1, total: 2 },
        }),
        true,
      );
      await Promise.resolve();
    },
  );

  assert.deepEqual(
    events.map(({ schemaVersion, sequence, type }) => ({
      schemaVersion,
      sequence,
      type,
    })),
    [
      { schemaVersion: 1, sequence: 1, type: "progress" },
      { schemaVersion: 1, sequence: 2, type: "process-end" },
    ],
  );
  assert.match(events[0].monotonicNs, /^\d+$/u);
  assert.ok(BigInt(events[1].monotonicNs) >= BigInt(events[0].monotonicNs));
  assert.deepEqual(events[0].type === "progress" ? events[0].progress : null, {
    stage: "embeddings",
    current: 1,
    total: 2,
  });
  assert.equal(
    events[1].type === "process-end" ? events[1].success : null,
    true,
  );
});

test("repository vector observer keeps concurrent run sequences isolated", async () => {
  const first: PerRepoSymbolVectorEvent[] = [];
  const second: PerRepoSymbolVectorEvent[] = [];

  await Promise.all([
    withPerRepoSymbolVectorObserver(
      (event) => first.push(event),
      async () => {
        emitPerRepoSymbolVectorEvent({
          type: "progress",
          repoId: "repo-a",
          progress: { stage: "scanning", current: 0, total: 1 },
        });
        await Promise.resolve();
        emitPerRepoSymbolVectorEvent({
          type: "progress",
          repoId: "repo-a",
          progress: { stage: "scanning", current: 1, total: 1 },
        });
      },
    ),
    withPerRepoSymbolVectorObserver(
      (event) => second.push(event),
      async () => {
        emitPerRepoSymbolVectorEvent({
          type: "progress",
          repoId: "repo-b",
          progress: { stage: "scanning", current: 0, total: 1 },
        });
        await Promise.resolve();
        emitPerRepoSymbolVectorEvent({
          type: "progress",
          repoId: "repo-b",
          progress: { stage: "scanning", current: 1, total: 1 },
        });
      },
    ),
  ]);

  assert.deepEqual(
    first.map((event) => event.sequence),
    [1, 2],
  );
  assert.deepEqual(
    second.map((event) => event.sequence),
    [1, 2],
  );
});

test("trace sink accepts only a regular file with the exact private marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdl-vector-trace-"));
  const invalidPath = join(dir, "invalid.trace");
  const validPath = join(dir, "valid.trace");

  try {
    writeFileSync(invalidPath, "wrong marker\n", "utf8");
    const invalidFd = openSync(invalidPath, "r+");
    try {
      assert.equal(openPerRepoSymbolVectorTraceSink(invalidFd), null);
    } finally {
      closeSync(invalidFd);
    }

    writeFileSync(validPath, PER_REPO_SYMBOL_VECTOR_TRACE_MARKER, "utf8");
    const validFd = openSync(validPath, "r+");
    try {
      const sink = openPerRepoSymbolVectorTraceSink(validFd);
      assert.ok(sink);
      sink({
        type: "process-end",
        success: true,
        maxRssBytes: 4_096,
        schemaVersion: 1,
        sequence: 1,
        monotonicNs: "1",
      });
    } finally {
      closeSync(validFd);
    }

    const trace = readFileSync(validPath, "utf8");
    assert.ok(trace.startsWith(PER_REPO_SYMBOL_VECTOR_TRACE_MARKER));
    assert.deepEqual(
      JSON.parse(
        trace.slice(PER_REPO_SYMBOL_VECTOR_TRACE_MARKER.length).trim(),
      ),
      {
        type: "process-end",
        success: true,
        maxRssBytes: 4_096,
        schemaVersion: 1,
        sequence: 1,
        monotonicNs: "1",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positional writer retries partial writes and rejects no progress", () => {
  const target = Buffer.alloc(10);
  const input = Buffer.from("abcdef", "utf8");
  let calls = 0;

  const finalPosition = writeAllAt(
    9,
    input,
    2,
    (_fd, buffer, offset, length, position) => {
      const written = Math.min(2, length);
      buffer.copy(target, position, offset, offset + written);
      calls += 1;
      return written;
    },
  );

  assert.equal(finalPosition, 8);
  assert.equal(calls, 3);
  assert.equal(target.subarray(2, 8).toString("utf8"), "abcdef");
  assert.throws(() => writeAllAt(9, input, 0, () => 0), /made no progress/u);
});

test("process trace writes exactly one failed terminal event before rethrowing", async () => {
  const events: PerRepoSymbolVectorEvent[] = [];

  await assert.rejects(
    withPerRepoSymbolVectorProcessTrace(
      (event) => events.push(event),
      async () => {
        emitPerRepoSymbolVectorEvent({
          type: "progress",
          repoId: "repo-a",
          progress: { stage: "scanning", current: 0, total: 1 },
        });
        throw new Error("index failed");
      },
    ),
    /index failed/u,
  );

  assert.equal(events.at(-1)?.type, "process-end");
  assert.equal(
    events.filter((event) => event.type === "process-end").length,
    1,
  );
  assert.equal(
    events.at(-1)?.type === "process-end" ? events.at(-1)?.success : null,
    false,
  );
});

test("instrumented CLI failure flushes one terminal event before nonzero exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdl-vector-cli-trace-"));
  const configPath = join(dir, "config.json");
  const tracePath = join(dir, "trace.jsonl");
  const graphPath = join(dir, "graph.lbug");
  let traceFd: number | null = null;

  try {
    writeFileSync(configPath, JSON.stringify({ repos: [] }), "utf8");
    traceFd = openSync(tracePath, "wx+");
    writeFileSync(traceFd, PER_REPO_SYMBOL_VECTOR_TRACE_MARKER, "utf8");

    const result = spawnSync(
      process.execPath,
      ["dist/cli/index.js", "--config", configPath, "index", "--force"],
      {
        cwd: process.cwd(),
        env: { ...process.env, SDL_GRAPH_DB_PATH: graphPath },
        stdio: ["ignore", "pipe", "pipe", traceFd],
        encoding: "utf8",
      },
    );
    closeSync(traceFd);
    traceFd = null;

    assert.equal(result.status, 1, result.stderr);
    const trace = readFileSync(tracePath, "utf8");
    const events = trace
      .slice(PER_REPO_SYMBOL_VECTOR_TRACE_MARKER.length)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PerRepoSymbolVectorEvent);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "process-end");
    assert.equal(
      events[0].type === "process-end" ? events[0].success : null,
      false,
    );
  } finally {
    if (traceFd !== null) closeSync(traceFd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace limits reserve enough bytes for the terminal event", () => {
  assert.equal(
    MAX_PER_REPO_SYMBOL_VECTOR_TRACE_BYTES,
    16 * 1_024 * 1_024,
  );
  assert.equal(
    PER_REPO_SYMBOL_VECTOR_TRACE_TERMINAL_RESERVE_BYTES,
    1_024,
  );

  const terminal: PerRepoSymbolVectorEvent = {
    type: "process-end",
    success: false,
    maxRssBytes: Number.MAX_SAFE_INTEGER,
    schemaVersion: 1,
    sequence: Number.MAX_SAFE_INTEGER,
    monotonicNs: "9".repeat(32),
  };
  assert.ok(
    Buffer.byteLength(`${JSON.stringify(terminal)}\n`, "utf8") <=
      PER_REPO_SYMBOL_VECTOR_TRACE_TERMINAL_RESERVE_BYTES,
  );
});

test("observer sequence advances only after the sink accepts an event", async () => {
  const accepted: PerRepoSymbolVectorEvent[] = [];

  await assert.rejects(
    withPerRepoSymbolVectorProcessTrace(
      (event) => {
        if (event.type === "progress") throw new Error("sink rejected event");
        accepted.push(event);
      },
      async () => {
        emitPerRepoSymbolVectorEvent({
          type: "progress",
          repoId: "repo-a",
          progress: { stage: "scanning", current: 0, total: 1 },
        });
      },
    ),
    /sink rejected event/u,
  );

  assert.deepEqual(
    accepted.map((event) => event.sequence),
    [1],
  );
  assert.equal(accepted[0]?.type, "process-end");
  assert.equal(
    accepted[0]?.type === "process-end" ? accepted[0].success : null,
    false,
  );
});

test("trace cap rejects nonterminal overflow and preserves the terminal reserve", () => {
  const maxTraceBytes = MAX_PER_REPO_SYMBOL_VECTOR_TRACE_BYTES;
  const terminalReserveBytes =
    PER_REPO_SYMBOL_VECTOR_TRACE_TERMINAL_RESERVE_BYTES;
  const dir = mkdtempSync(join(tmpdir(), "sdl-vector-trace-cap-"));
  const tracePath = join(dir, "trace.jsonl");
  let traceFd: number | null = null;

  try {
    writeFileSync(tracePath, PER_REPO_SYMBOL_VECTOR_TRACE_MARKER, "utf8");
    traceFd = openSync(tracePath, "r+");
    const sink = openPerRepoSymbolVectorTraceSink(traceFd);
    assert.ok(sink);

    const boundaryEvent: PerRepoSymbolVectorEvent = {
      type: "progress",
      repoId: "repo-a",
      progress: {
        stage: "scanning",
        current: 0,
        total: 1,
        message: "",
      },
      schemaVersion: 1,
      sequence: 0,
      monotonicNs: "0",
    };
    const emptyLineBytes = Buffer.byteLength(
      `${JSON.stringify(boundaryEvent)}\n`,
      "utf8",
    );
    const markerBytes = Buffer.byteLength(
      PER_REPO_SYMBOL_VECTOR_TRACE_MARKER,
      "utf8",
    );
    const fillerBytes =
      maxTraceBytes -
      terminalReserveBytes -
      markerBytes -
      emptyLineBytes;
    assert.ok(fillerBytes > 0);
    if (boundaryEvent.type === "progress") {
      boundaryEvent.progress.message = "x".repeat(fillerBytes);
    }
    assert.equal(
      markerBytes +
        Buffer.byteLength(`${JSON.stringify(boundaryEvent)}\n`, "utf8"),
      maxTraceBytes - terminalReserveBytes,
    );

    sink(boundaryEvent);
    assert.equal(
      statSync(tracePath).size,
      maxTraceBytes - terminalReserveBytes,
    );
    assert.throws(
      () =>
        sink({
          type: "progress",
          repoId: "repo-a",
          progress: { stage: "scanning", current: 1, total: 1 },
          schemaVersion: 1,
          sequence: 1,
          monotonicNs: "1",
        }),
      /trace byte limit exceeded/u,
    );
    assert.equal(
      statSync(tracePath).size,
      maxTraceBytes - terminalReserveBytes,
    );

    sink({
      type: "process-end",
      success: false,
      maxRssBytes: 4_096,
      schemaVersion: 1,
      sequence: 1,
      monotonicNs: "1",
    });
    assert.ok(statSync(tracePath).size > maxTraceBytes - terminalReserveBytes);
    assert.ok(statSync(tracePath).size <= maxTraceBytes);
  } finally {
    if (traceFd !== null) closeSync(traceFd);
    rmSync(dir, { recursive: true, force: true });
  }
});
