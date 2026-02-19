import type { Range } from "../mcp/types.js";

export interface TruncationMetadata {
  truncated: boolean;
  droppedCount: number;
  howToResume: {
    type: "cursor" | "token";
    value: string | number;
  } | null;
}

export interface TruncationOptions {
  maxItems?: number;
  maxTokens?: number;
  maxLines?: number;
  truncateAt?: "start" | "end";
  preserveFirst?: number;
  preserveLast?: number;
}

export interface TruncatedArray<T> extends TruncationMetadata {
  items: T[];
}

export interface TruncatedText extends TruncationMetadata {
  text: string;
}

export interface TruncatedResult<T> {
  data: T;
  truncation: TruncationMetadata;
}

function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const chars = text.length;
  return Math.max(words.length, Math.floor(chars / 4));
}

export function applyCountTruncation<T>(
  items: T[],
  options: TruncationOptions,
): TruncatedArray<T> {
  const maxItems = options.maxItems ?? Infinity;

  if (items.length <= maxItems) {
    return {
      items,
      truncated: false,
      droppedCount: 0,
      howToResume: null,
    };
  }

  const preserveFirst = options.preserveFirst ?? 0;
  const preserveLast = options.preserveLast ?? 0;
  const truncateAt = options.truncateAt ?? "end";

  let truncatedItems: T[];
  let droppedCount: number;
  let howToResumeValue: number;

  if (truncateAt === "end") {
    const keepCount = Math.min(maxItems, items.length);
    truncatedItems = items.slice(0, keepCount);
    droppedCount = items.length - keepCount;
    howToResumeValue = keepCount;
  } else if (truncateAt === "start") {
    const keepCount = Math.min(maxItems, items.length);
    truncatedItems = items.slice(-keepCount);
    droppedCount = items.length - keepCount;
    howToResumeValue = droppedCount;
  } else {
    const firstCount = Math.min(preserveFirst, maxItems / 2);
    const lastCount = Math.min(preserveLast, maxItems - firstCount);
    const middleCount = Math.max(0, maxItems - firstCount - lastCount);

    const firstItems = items.slice(0, firstCount);
    const lastItems = items.slice(-lastCount);
    const middleItems =
      middleCount > 0 ? items.slice(firstCount, firstCount + middleCount) : [];

    truncatedItems = [...firstItems, ...middleItems, ...lastItems];
    droppedCount = items.length - truncatedItems.length;
    howToResumeValue = firstCount + middleCount;
  }

  return {
    items: truncatedItems,
    truncated: true,
    droppedCount,
    howToResume: {
      type: "cursor",
      value: howToResumeValue,
    },
  };
}

export function applyTokenTruncation(
  text: string,
  options: TruncationOptions,
): TruncatedText {
  const maxTokens = options.maxTokens ?? Infinity;
  const estimatedTokens = estimateTokens(text);

  if (estimatedTokens <= maxTokens) {
    return {
      text,
      truncated: false,
      droppedCount: 0,
      howToResume: null,
    };
  }

  const truncateAt = options.truncateAt ?? "end";
  const lines = text.split("\n");
  const avgTokensPerLine = lines.length > 0 ? estimatedTokens / lines.length : 1;
  const maxLines = avgTokensPerLine > 0 ? Math.floor(maxTokens / avgTokensPerLine) : lines.length;

  let truncatedLines: string[];
  let droppedCount: number;

  if (truncateAt === "end") {
    truncatedLines = lines.slice(0, Math.max(1, maxLines));
    droppedCount = lines.length - truncatedLines.length;
  } else if (truncateAt === "start") {
    truncatedLines = lines.slice(-Math.max(1, maxLines));
    droppedCount = lines.length - truncatedLines.length;
  } else {
    const preserveFirst = options.preserveFirst ?? 0;
    const preserveLast = options.preserveLast ?? 0;
    const firstCount = Math.min(preserveFirst, maxLines / 2);
    const lastCount = Math.min(preserveLast, maxLines - firstCount);
    const middleCount = Math.max(0, maxLines - firstCount - lastCount);

    const firstLines = lines.slice(0, firstCount);
    const lastLines = lines.slice(-lastCount);
    const middleLines =
      middleCount > 0 ? lines.slice(firstCount, firstCount + middleCount) : [];

    truncatedLines = [...firstLines, ...middleLines, ...lastLines];
    droppedCount = lines.length - truncatedLines.length;
  }

  const truncatedText = truncatedLines.join("\n");

  return {
    text: truncatedText,
    truncated: true,
    droppedCount,
    howToResume: {
      type: "token",
      value: estimateTokens(truncatedText),
    },
  };
}

export function applyLineTruncation(
  text: string,
  options: TruncationOptions,
): TruncatedText {
  const maxLines = options.maxLines ?? Infinity;
  const lines = text.split("\n");

  if (lines.length <= maxLines) {
    return {
      text,
      truncated: false,
      droppedCount: 0,
      howToResume: null,
    };
  }

  const truncateAt = options.truncateAt ?? "end";

  let truncatedLines: string[];
  let droppedCount: number;

  if (truncateAt === "end") {
    truncatedLines = lines.slice(0, maxLines);
    droppedCount = lines.length - maxLines;
  } else if (truncateAt === "start") {
    truncatedLines = lines.slice(-maxLines);
    droppedCount = lines.length - maxLines;
  } else {
    const preserveFirst = options.preserveFirst ?? 0;
    const preserveLast = options.preserveLast ?? 0;
    const firstCount = Math.min(preserveFirst, maxLines / 2);
    const lastCount = Math.min(preserveLast, maxLines - firstCount);
    const middleCount = Math.max(0, maxLines - firstCount - lastCount);

    const firstLines = lines.slice(0, firstCount);
    const lastLines = lines.slice(-lastCount);
    const middleLines =
      middleCount > 0 ? lines.slice(firstCount, firstCount + middleCount) : [];

    truncatedLines = [...firstLines, ...middleLines, ...lastLines];
    droppedCount = lines.length - truncatedLines.length;
  }

  const truncatedText = truncatedLines.join("\n");

  return {
    text: truncatedText,
    truncated: true,
    droppedCount,
    howToResume: {
      type: "cursor",
      value: truncatedLines.length,
    },
  };
}

export function truncateText(
  text: string,
  options: TruncationOptions,
): TruncatedText {
  if (options.maxTokens !== undefined && options.maxLines !== undefined) {
    const tokenResult = applyTokenTruncation(text, {
      ...options,
      maxLines: undefined,
    });
    const lineResult = applyLineTruncation(tokenResult.text, {
      ...options,
      maxTokens: undefined,
    });
    return {
      text: lineResult.text,
      truncated: tokenResult.truncated || lineResult.truncated,
      droppedCount: tokenResult.droppedCount + lineResult.droppedCount,
      howToResume: lineResult.howToResume,
    };
  }

  if (options.maxTokens !== undefined) {
    return applyTokenTruncation(text, options);
  }

  if (options.maxLines !== undefined) {
    return applyLineTruncation(text, options);
  }

  return {
    text,
    truncated: false,
    droppedCount: 0,
    howToResume: null,
  };
}

export function truncateArray<T>(
  items: T[],
  options: TruncationOptions,
): TruncatedArray<T> {
  if (options.maxItems === undefined) {
    return {
      items,
      truncated: false,
      droppedCount: 0,
      howToResume: null,
    };
  }

  return applyCountTruncation(items, options);
}

export function truncateRange(
  range: Range,
  options: TruncationOptions,
): { range: Range; truncation: TruncationMetadata } {
  const lines = range.endLine - range.startLine + 1;
  const maxLines = options.maxLines ?? Infinity;

  if (lines <= maxLines) {
    return {
      range,
      truncation: {
        truncated: false,
        droppedCount: 0,
        howToResume: null,
      },
    };
  }

  const truncateAt = options.truncateAt ?? "end";

  let truncatedRange: Range;
  let droppedCount: number;

  if (truncateAt === "end") {
    truncatedRange = {
      ...range,
      endLine: range.startLine + maxLines - 1,
      endCol: 0,
    };
    droppedCount = lines - maxLines;
  } else if (truncateAt === "start") {
    truncatedRange = {
      ...range,
      startLine: range.endLine - maxLines + 1,
      startCol: 0,
    };
    droppedCount = lines - maxLines;
  } else {
    const preserveFirst = options.preserveFirst ?? 0;
    const preserveLast = options.preserveLast ?? 0;
    const firstCount = Math.min(preserveFirst, maxLines / 2);
    const lastCount = Math.min(preserveLast, maxLines - firstCount);

    const middleStart = range.startLine + firstCount;
    const middleEnd = range.endLine - lastCount;
    const middleCount = maxLines - firstCount - lastCount;

    const computedEnd = Math.min(middleStart + middleCount - 1, middleEnd);
    truncatedRange = {
      startLine: middleStart,
      startCol: 0,
      endLine: Math.max(middleStart, computedEnd),
      endCol: 0,
    };
    droppedCount = lines - maxLines;
  }

  return {
    range: truncatedRange,
    truncation: {
      truncated: true,
      droppedCount,
      howToResume: {
        type: "cursor",
        value: truncatedRange.endLine,
      },
    },
  };
}

export function mergeTruncationMetadata(
  truncations: TruncationMetadata[],
): TruncationMetadata {
  const anyTruncated = truncations.some((t) => t.truncated);
  const totalDropped = truncations.reduce((sum, t) => sum + t.droppedCount, 0);

  const lastTruncation = [...truncations].reverse().find((t) => t.truncated);

  return {
    truncated: anyTruncated,
    droppedCount: totalDropped,
    howToResume: lastTruncation?.howToResume ?? null,
  };
}
