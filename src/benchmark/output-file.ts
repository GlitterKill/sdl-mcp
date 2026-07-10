import { writeFileSync } from "node:fs";

export type Utf8OutputMode = "overwrite" | "exclusive";

export function writeUtf8Output(
  filePath: string,
  bytes: string,
  mode: Utf8OutputMode,
): void {
  writeFileSync(filePath, bytes, {
    encoding: "utf8",
    flag: mode === "exclusive" ? "wx" : "w",
  });
}
