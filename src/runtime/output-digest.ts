/**
 * Parses common tool output (tsc, node:test, eslint, npm) into compact
 * structured failure digests for runtime.execute `outputMode: "digest"`.
 * Full output stays behind the persisted artifact / runtime.queryOutput path.
 */

export interface DigestFailure {
  /** Test name when known. */
  name?: string;
  /** Repo-relative file path when parseable. */
  file?: string;
  line?: number;
  /** First line of the error, trimmed to 200 chars. */
  message: string;
}

export interface OutputDigest {
  kind: "tsc" | "node-test" | "eslint" | "npm" | "generic";
  ok: boolean;
  /** One line, e.g. "2 errors in 2 files". */
  summary: string;
  failures: DigestFailure[];
  truncatedFailures?: number;
  /** Generic fallback only: bounded excerpt around the first error. */
  excerpt?: string;
}

export interface DigestInput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** When set, this absolute prefix is stripped from parsed file paths. */
  rootPath?: string;
}

const MAX_FAILURES = 20;
const MAX_MESSAGE_CHARS = 200;
const GENERIC_HEAD_LINES = 10;
const GENERIC_CONTEXT_LINES = 10;

const TSC_ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+: .*)$/;
const TSC_ERROR_SNIFF = /^.+\(\d+,\d+\): error TS\d+:/m;
const NODE_TEST_FAIL_LINE = /^\s*[✖×] (.+)$/;
const NODE_TEST_TAP_FAIL_LINE = /^not ok \d+ - (.+)$/;
const NODE_TEST_SNIFF = /^(?:ℹ tests \d+|not ok \d+ -|TAP version )/m;
const ESLINT_ROW =
  /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([^\s]+))?$/;
const ESLINT_TRAILER = /[✖×] (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/;
const NPM_ERR_PREFIX = /^npm (?:ERR!|error)\s?/;
const GENERIC_ERROR_SNIFF = /error|exception|failed/i;

function trimMessage(message: string): string {
  const firstLine = message.split("\n", 1)[0].trim();
  return firstLine.length > MAX_MESSAGE_CHARS
    ? firstLine.slice(0, MAX_MESSAGE_CHARS)
    : firstLine;
}

function normalizeDigestPath(filePath: string, rootPath?: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  if (rootPath) {
    const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
  }
  return normalized;
}

function capFailures(failures: DigestFailure[]): {
  failures: DigestFailure[];
  truncatedFailures?: number;
} {
  if (failures.length <= MAX_FAILURES) {
    return { failures };
  }
  return {
    failures: failures.slice(0, MAX_FAILURES),
    truncatedFailures: failures.length - MAX_FAILURES,
  };
}

function detectKind(input: DigestInput): OutputDigest["kind"] {
  const command = input.command.toLowerCase();
  const text = `${input.stdout}\n${input.stderr}`;
  if (
    /(^|[\\/\s])tsc(\.cmd|\.exe|\.js)?(\s|$)/.test(command) ||
    TSC_ERROR_SNIFF.test(text)
  ) {
    return "tsc";
  }
  if (
    /(^|[\\/\s])node(\.exe)?\s+(?:.*\s)?--test(\s|$)/.test(command) ||
    NODE_TEST_SNIFF.test(text)
  ) {
    return "node-test";
  }
  if (
    /(^|[\\/\s])eslint(\.cmd|\.js)?(\s|$)/.test(command) ||
    ESLINT_TRAILER.test(text)
  ) {
    return "eslint";
  }
  if (NPM_ERR_PREFIX.test(text) || /^npm (?:ERR!|error)/m.test(text)) {
    return "npm";
  }
  return "generic";
}

function digestTsc(input: DigestInput): OutputDigest {
  const text = `${input.stdout}\n${input.stderr}`;
  const failures: DigestFailure[] = [];
  for (const line of text.split("\n")) {
    const match = TSC_ERROR_LINE.exec(line);
    if (!match) continue;
    failures.push({
      file: normalizeDigestPath(match[1], input.rootPath),
      line: Number.parseInt(match[2], 10),
      message: trimMessage(match[4]),
    });
  }
  const trailer = /Found (\d+) errors?(?: in (\d+) files?)?/.exec(text);
  const summary =
    trailer?.[2] !== undefined
      ? `${trailer[1]} errors in ${trailer[2]} files`
      : `${failures.length} errors`;
  return {
    kind: "tsc",
    ok: failures.length === 0 && input.exitCode === 0,
    summary,
    ...capFailures(failures),
  };
}

function digestNodeTest(input: DigestInput): OutputDigest {
  const lines = `${input.stdout}\n${input.stderr}`.split("\n");
  const failuresByName = new Map<string, DigestFailure>();

  for (let i = 0; i < lines.length; i++) {
    const failMatch =
      NODE_TEST_FAIL_LINE.exec(lines[i]) ??
      NODE_TEST_TAP_FAIL_LINE.exec(lines[i]);
    if (!failMatch) continue;

    const name = failMatch[1].replace(/\s*\(\d+(?:\.\d+)?ms\)\s*$/, "").trim();
    if (/^failing tests:?$/i.test(name)) continue;

    let message = "";
    for (let j = i + 1; j < lines.length && j <= i + 20; j++) {
      const candidate = lines[j];
      if (/^\s+\S/.test(candidate) && /Error/.test(candidate)) {
        message = trimMessage(candidate);
        break;
      }
      // Stop scanning at the next test result line.
      if (
        NODE_TEST_FAIL_LINE.test(candidate) ||
        NODE_TEST_TAP_FAIL_LINE.test(candidate) ||
        /^\s*[✔√] /.test(candidate)
      ) {
        break;
      }
    }

    const key = name;
    const existing = failuresByName.get(key);
    if (!existing) {
      failuresByName.set(key, {
        name,
        message: message || `test failed: ${name}`,
      });
    } else if (
      message &&
      existing.message === `test failed: ${existing.name}`
    ) {
      existing.message = message;
    }
  }

  const failures = [...failuresByName.values()];
  const total = /^ℹ tests (\d+)/m.exec(input.stdout)?.[1];
  const failed = /^ℹ fail (\d+)/m.exec(input.stdout)?.[1];
  const tapPlan = /^1\.\.(\d+)/m.exec(input.stdout)?.[1];
  const totalCount = total ?? tapPlan;
  const failedCount = failed ?? String(failures.length);
  const summary =
    totalCount !== undefined
      ? `${failedCount}/${totalCount} tests failed`
      : `${failedCount} tests failed`;
  return {
    kind: "node-test",
    ok:
      failures.length === 0 &&
      Number(failedCount) === 0 &&
      input.exitCode === 0,
    summary,
    ...capFailures(failures),
  };
}

function digestEslint(input: DigestInput): OutputDigest {
  const lines = `${input.stdout}\n${input.stderr}`.split("\n");
  const errors: DigestFailure[] = [];
  const warnings: DigestFailure[] = [];
  let currentFile: string | undefined;
  for (const line of lines) {
    const row = ESLINT_ROW.exec(line);
    if (row) {
      const failure: DigestFailure = {
        file: currentFile,
        line: Number.parseInt(row[1], 10),
        message: trimMessage(row[5] ? `${row[4]} (${row[5]})` : row[4]),
      };
      (row[3] === "error" ? errors : warnings).push(failure);
      continue;
    }
    const trimmed = line.trim();
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith("✖") &&
      !/^\d/.test(trimmed)
    ) {
      currentFile = normalizeDigestPath(trimmed, input.rootPath);
    }
  }
  const failures = errors.length > 0 ? errors : warnings;
  const trailer = ESLINT_TRAILER.exec(`${input.stdout}\n${input.stderr}`);
  const summary = trailer
    ? trailer[0].replace(/^[✖×] /, "")
    : `${errors.length} errors, ${warnings.length} warnings`;
  return {
    kind: "eslint",
    ok: errors.length === 0 && input.exitCode === 0,
    summary,
    ...capFailures(failures),
  };
}

function digestNpm(input: DigestInput): OutputDigest {
  const lines = `${input.stderr}\n${input.stdout}`.split("\n");
  const payloads: string[] = [];
  for (const line of lines) {
    if (!NPM_ERR_PREFIX.test(line)) continue;
    const payload = trimMessage(line.replace(NPM_ERR_PREFIX, ""));
    if (payload.length === 0 || payloads.includes(payload)) continue;
    payloads.push(payload);
    if (payloads.length >= 5) break;
  }
  const failures = payloads.map((message) => ({ message }));
  return {
    kind: "npm",
    ok: input.exitCode === 0 && failures.length === 0,
    summary: payloads[0] ?? `npm exited with code ${input.exitCode ?? "none"}`,
    ...capFailures(failures),
  };
}

function digestGeneric(input: DigestInput): OutputDigest {
  const ok = input.exitCode === 0;
  const failures: DigestFailure[] = [];
  const firstStderrLine = input.stderr
    .split("\n")
    .find((line) => line.trim().length > 0);
  const stdoutLines = input.stdout.split("\n");
  const firstErrorIndex = stdoutLines.findIndex((line) =>
    GENERIC_ERROR_SNIFF.test(line),
  );
  if (!ok || firstStderrLine !== undefined || firstErrorIndex >= 0) {
    const message =
      firstStderrLine ??
      (firstErrorIndex >= 0 ? stdoutLines[firstErrorIndex] : undefined);
    if (message !== undefined) {
      failures.push({ message: trimMessage(message) });
    }
  }

  let excerpt: string | undefined;
  if (!ok) {
    const head = stdoutLines.slice(0, GENERIC_HEAD_LINES);
    const excerptLines = [...head];
    if (firstErrorIndex >= GENERIC_HEAD_LINES) {
      const start = Math.max(
        GENERIC_HEAD_LINES,
        firstErrorIndex - Math.floor(GENERIC_CONTEXT_LINES / 2),
      );
      excerptLines.push("…");
      excerptLines.push(
        ...stdoutLines.slice(start, start + GENERIC_CONTEXT_LINES),
      );
    } else if (stdoutLines.length > GENERIC_HEAD_LINES) {
      excerptLines.push("…");
      excerptLines.push(...stdoutLines.slice(-GENERIC_CONTEXT_LINES));
    }
    if (firstStderrLine !== undefined) {
      excerptLines.push("…");
      excerptLines.push(trimMessage(firstStderrLine));
    }
    excerpt = excerptLines.slice(0, 30).join("\n");
  }

  return {
    kind: "generic",
    ok,
    summary: ok
      ? "command succeeded"
      : (failures[0]?.message ??
        `command exited with code ${input.exitCode ?? "none"}`),
    ...capFailures(failures),
    ...(excerpt !== undefined ? { excerpt } : {}),
  };
}

export function buildOutputDigest(input: DigestInput): OutputDigest {
  switch (detectKind(input)) {
    case "tsc":
      return digestTsc(input);
    case "node-test":
      return digestNodeTest(input);
    case "eslint":
      return digestEslint(input);
    case "npm":
      return digestNpm(input);
    default:
      return digestGeneric(input);
  }
}
