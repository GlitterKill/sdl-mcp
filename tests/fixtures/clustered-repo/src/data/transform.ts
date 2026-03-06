import { cache } from "./cache";
import { query } from "./query";

export function transform(value: string): string {
  return cache(value);
}

export function transformLoop(value: string): string {
  return query(value);
}

function transformInternal(): string {
  return transform("internal");
}

export function transformInternalEntry(): string {
  return transformInternal();
}
