import { handleSliceBuild } from '../src/mcp/tools/slice.js';

const repoId = 'sdl-mcp';
const result = await handleSliceBuild({
  repoId,
  taskText: 'Investigate symbol search and code window gating behavior',
  budget: { maxCards: 50, maxEstimatedTokens: 3000 }
});

console.log(JSON.stringify({
  repoId: result.slice.repoId,
  versionId: result.slice.versionId,
  startSymbols: result.slice.startSymbols.length,
  cards: result.slice.cards.length,
  edges: result.slice.edges.length,
  frontier: result.slice.frontier?.length ?? 0
}, null, 2));
