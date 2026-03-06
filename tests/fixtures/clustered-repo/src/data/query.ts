import { transform } from "./transform";

export function query(value: string): string {
  return transform(value);
}

function queryInternal(): string {
  return query("internal");
}

export function queryInternalEntry(): string {
  return queryInternal();
}
