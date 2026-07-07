import { setActiveLens } from "../state.js";
import type { UniverseRenderer } from "../universe.js";

export function applyCommunityLens(universe: UniverseRenderer): void {
  setActiveLens("community");
  universe.applyCommunityColors();
}
