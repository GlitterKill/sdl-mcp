import type { LayoutResult } from "./types.js";

function formatJsonNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const normalized = Object.is(value, -0) ? 0 : value;
  return Number.isInteger(normalized) ? normalized.toFixed(0) : JSON.stringify(normalized);
}

export function serializeLayoutResult(result: LayoutResult): string {
  const positions = result.positions
    .map((position) =>
      '{"id":' + JSON.stringify(position.id) +
      ',"x":' + formatJsonNumber(position.x) +
      ',"y":' + formatJsonNumber(position.y) +
      ',"z":' + formatJsonNumber(position.z) + '}',
    )
    .join(",");
  return (
    '{"layoutSchemaVersion":' + result.layoutSchemaVersion +
    ',"seed":' + result.seed +
    ',"iterations":' + result.iterations +
    ',"inputHash":' + JSON.stringify(result.inputHash) +
    ',"positions":[' + positions + ']}'
  );
}
