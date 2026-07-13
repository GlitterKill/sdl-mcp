export type Eol = "\r\n" | "\n";

/** Select the majority newline style, defaulting ties and newline-free text to LF. */
export function detectDominantEol(content: string): Eol {
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

/** Normalize text-edit content to the internal LF representation. */
export function normalizeToLf(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Restore normalized text to a target EOL without double-converting CRLF. */
export function restoreEol(content: string, eol: Eol): string {
  const normalized = normalizeToLf(content);
  return eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}
