import { join, resolve } from "path";

const MATRIX_GRAPH_DB_DIR = "graph-db";
const MATRIX_GRAPH_DB_FILENAME = "sdl-mcp-graph.lbug";

function encodeRepoId(repoId: string): string {
  return encodeURIComponent(repoId);
}

export function buildMatrixGraphDbPath(outDir: string, repoId: string): string {
  return resolve(
    join(outDir, MATRIX_GRAPH_DB_DIR, encodeRepoId(repoId), MATRIX_GRAPH_DB_FILENAME),
  );
}

export function buildMatrixRunEnv(
  baseEnv: NodeJS.ProcessEnv,
  outDir: string,
  repoId: string,
): NodeJS.ProcessEnv {
  const graphDbPath = buildMatrixGraphDbPath(outDir, repoId);
  return {
    ...baseEnv,
    SDL_GRAPH_DB_PATH: graphDbPath,
    SDL_DB_PATH: graphDbPath,
  };
}
