export const KIND_COLORS: Record<string, string> = {
  function: "#7fd0ff",
  method: "#84e0a6",
  class: "#f4c76b",
  interface: "#c9a7ff",
  variable: "#f28f8f",
  import: "#9aa4b2",
  call: "#5eead4",
  config: "#f59e0b",
};

export const COMMUNITY_PALETTE = [
  "#7fd0ff", "#84e0a6", "#f4c76b", "#c9a7ff", "#f28f8f", "#5eead4", "#f59e0b", "#93c5fd",
  "#bef264", "#fca5a5", "#a78bfa", "#67e8f9", "#fde68a", "#fdba74", "#86efac", "#d8b4fe",
  "#99f6e4", "#f0abfc", "#bae6fd", "#fecdd3", "#bbf7d0", "#ddd6fe", "#fed7aa", "#e0f2fe",
];

export function hashColor(input: string, palette = COMMUNITY_PALETTE): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return palette[hash % palette.length];
}
