import { query } from "./query";

export function cache(value: string): string {
  query(value);
  return `cache:${value}`;
}

function cacheInternal(): string {
  return cache("internal");
}

export function cacheInternalEntry(): string {
  return cacheInternal();
}
