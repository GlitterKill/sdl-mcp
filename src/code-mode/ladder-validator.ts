import type { ParsedWorkflowStep } from "./workflow-parser.js";

const RUNG_ORDER: Record<string, number> = {
  "symbol.search": 0,
  "symbol.getCard": 1,
  "symbol.getCards": 1,
  "slice.build": 1,
  "code.getSkeleton": 2,
  "code.getHotPath": 3,
  "code.needWindow": 4,
};

export function validateLadder(
  steps: ParsedWorkflowStep[],
  _priorResults: unknown[],
  mode: "off" | "warn" | "enforce",
): string[] {
  if (mode === "off") return [];

  const warnings: string[] = [];
  const symbolHighestRung = new Map<string, number>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // Skip internal transform steps (ladder-neutral)
    if (step.internal) continue;

    const rung = RUNG_ORDER[step.action];

    // Skip actions not in the ladder map (neutral)
    if (rung === undefined) continue;

    // Extract symbolId from args
    const args = step.args;
    let symbolId: string | undefined;

    if (typeof args.symbolId === "string") {
      symbolId = args.symbolId;
    } else if (
      Array.isArray(args.entrySymbols) &&
      args.entrySymbols.length > 0
    ) {
      const first = args.entrySymbols[0];
      if (typeof first === "string") {
        symbolId = first;
      }
    }

    // Skip if no symbolId found (neutral)
    if (symbolId === undefined) continue;

    const prevRung = symbolHighestRung.get(symbolId);
    if (prevRung !== undefined && rung > prevRung + 1) {
      warnings.push(
        `Step ${i} (${step.fn}) skips to rung ${rung} for symbol ${symbolId} — consider card/skeleton first`,
      );
    }

    symbolHighestRung.set(symbolId, Math.max(rung, prevRung ?? rung));
  }

  return warnings;
}
