import type { OutputExcerpt } from "../runtime/types.js";

const NODE_TEST_DURATION_LINE =
  /^(\s*(?:[✔✖×] .+|(?:ok|not ok) \d+ - .+?))\s+\(\d+(?:\.\d+)?ms\)(\r?)$/;

export function isWindowsCmdEchoLine(line: string): boolean {
  return /^[A-Za-z]:\\[^>]*>/.test(line) || /^\\\\[^>]+>/.test(line);
}

function isNodeOutput(runtime?: string, commandSummary?: string): boolean {
  return (
    runtime?.toLowerCase() === "node" ||
    /\bexecutable=node(?:\.exe)?\b/i.test(commandSummary ?? "")
  );
}

export function projectRuntimeOutputExcerpts(
  excerpts: readonly OutputExcerpt[],
  runtime?: string,
  commandSummary?: string,
): OutputExcerpt[] {
  const stripNodeDurations = isNodeOutput(runtime, commandSummary);

  return excerpts.flatMap((excerpt) => {
    const lines = excerpt.content.split("\n");
    let removedLeadingLines = 0;
    while (lines.length > 0) {
      let echoIndex = 0;
      while (
        echoIndex < lines.length &&
        lines[echoIndex].trim().length === 0
      ) {
        echoIndex++;
      }
      if (
        echoIndex >= lines.length ||
        !isWindowsCmdEchoLine(lines[echoIndex])
      ) {
        break;
      }
      lines.splice(0, echoIndex + 1);
      removedLeadingLines += echoIndex + 1;
    }
    if (
      removedLeadingLines > 0 &&
      (lines.length === 0 || lines.every((line) => line.trim().length === 0))
    ) {
      return [];
    }

    return [
      {
        ...excerpt,
        lineStart: excerpt.lineStart + removedLeadingLines,
        content: lines
          .map((line) =>
            stripNodeDurations
              ? line.replace(NODE_TEST_DURATION_LINE, "$1$2")
              : line,
          )
          .join("\n"),
      },
    ];
  });
}
