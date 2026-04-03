import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STRESS_REPO_ID = "stress-fixtures";
export const STRESS_EDITFUL_TARGET_REL_PATH = "src/typescript/utils.ts";
export const STRESS_EDITFUL_BLOCK_START = "// stress-editful:start";
export const STRESS_EDITFUL_BLOCK_END = "// stress-editful:end";

export interface StressToolCaller {
  callToolParsed(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export function stripStressFixtureEditBlock(content: string): string {
  const start = content.indexOf(STRESS_EDITFUL_BLOCK_START);
  if (start === -1) {
    return content;
  }

  const end = content.indexOf(STRESS_EDITFUL_BLOCK_END, start);
  if (end === -1) {
    return content;
  }

  const afterBlock = end + STRESS_EDITFUL_BLOCK_END.length;
  return `${content.slice(0, start).trimEnd()}\n`;
}

export function buildStressFixtureEditContent(
  baseContent: string,
  iteration: number,
): string {
  const normalizedBase = stripStressFixtureEditBlock(baseContent).trimEnd();
  return [
    normalizedBase,
    "",
    STRESS_EDITFUL_BLOCK_START,
    `// Iteration ${iteration} forces a structural TS edit for incremental indexing.`,
    `export function __stressEditMarker${iteration}(): number {`,
    `  const markerValue${iteration} = ${iteration};`,
    `  return markerValue${iteration};`,
    "}",
    STRESS_EDITFUL_BLOCK_END,
    "",
  ].join("\n");
}

export interface StressFixtureEditSession {
  targetPath: string;
  applyIteration(iteration: number): Promise<void>;
  restore(): Promise<void>;
}

export async function createStressFixtureEditSession(
  fixturePath: string,
): Promise<StressFixtureEditSession> {
  const targetPath = join(fixturePath, STRESS_EDITFUL_TARGET_REL_PATH);
  const currentContent = await readFile(targetPath, "utf8");
  const baseContent = stripStressFixtureEditBlock(currentContent);

  const writeWithFreshMtime = async (content: string): Promise<void> => {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");

    // Incremental indexing keys off mtime, so force the timestamp forward to
    // avoid same-millisecond writes being treated as unchanged.
    const future = new Date(Date.now() + 1500);
    await utimes(targetPath, future, future);
  };

  return {
    targetPath,
    async applyIteration(iteration: number): Promise<void> {
      await writeWithFreshMtime(
        buildStressFixtureEditContent(baseContent, iteration),
      );
    },
    async restore(): Promise<void> {
      await writeWithFreshMtime(baseContent);
    },
  };
}

export async function ensureStressFixtureReady(
  client: StressToolCaller,
  fixturePath: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const status = await client.callToolParsed("sdl.repo.status", {
      repoId: STRESS_REPO_ID,
    });
    const symbolsIndexed =
      typeof status.symbolsIndexed === "number" ? status.symbolsIndexed : 0;
    const filesIndexed =
      typeof status.filesIndexed === "number" ? status.filesIndexed : 0;

    if (symbolsIndexed > 0 && filesIndexed > 0) {
      log("Setup: Reusing existing indexed fixture repo");
      return;
    }

    log("Setup: Fixture repo is present but not indexed; running full refresh");
  } catch {
    log("Setup: Registering fixture repo for mixed read-write");
    await client.callToolParsed("sdl.repo.register", {
      repoId: STRESS_REPO_ID,
      rootPath: fixturePath,
    });
  }

  await client.callToolParsed("sdl.index.refresh", {
    repoId: STRESS_REPO_ID,
    mode: "full",
  });
}
