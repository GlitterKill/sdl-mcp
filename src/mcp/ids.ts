declare const brandRepoId: unique symbol;
declare const brandSymbolId: unique symbol;
declare const brandVersionId: unique symbol;

export type RepoId = string & { readonly [brandRepoId]: "RepoId" };
export type SymbolId = string & { readonly [brandSymbolId]: "SymbolId" };
export type VersionId = string & { readonly [brandVersionId]: "VersionId" };

const REPO_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SYMBOL_ID_PATTERN = /^[a-zA-Z0-9_:./#-]+$/;
const VERSION_ID_PATTERN = /^v?\d+$/;

function isValidRepoId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && REPO_ID_PATTERN.test(value);
}

function isValidSymbolId(value: string): boolean {
  return (
    value.length > 0 && value.length <= 512 && SYMBOL_ID_PATTERN.test(value)
  );
}

function isValidVersionId(value: string): boolean {
  return (
    value.length > 0 && value.length <= 64 && VERSION_ID_PATTERN.test(value)
  );
}

export function asRepoId(value: string): RepoId {
  if (!isValidRepoId(value)) {
    throw new TypeError(`Invalid RepoId: ${value}`);
  }
  return value as RepoId;
}

export function asSymbolId(value: string): SymbolId {
  if (!isValidSymbolId(value)) {
    throw new TypeError(`Invalid SymbolId: ${value}`);
  }
  return value as SymbolId;
}

export function asVersionId(value: string): VersionId {
  if (!isValidVersionId(value)) {
    throw new TypeError(`Invalid VersionId: ${value}`);
  }
  return value as VersionId;
}

export function uncheckedAsRepoId(value: string): RepoId {
  return value as RepoId;
}

export function uncheckedAsSymbolId(value: string): SymbolId {
  return value as SymbolId;
}

export function uncheckedAsVersionId(value: string): VersionId {
  return value as VersionId;
}

export function isRepoId(value: string): value is RepoId {
  return isValidRepoId(value);
}

export function isSymbolId(value: string): value is SymbolId {
  return isValidSymbolId(value);
}

export function isVersionId(value: string): value is VersionId {
  return isValidVersionId(value);
}

export function toRawRepoId(id: RepoId): string {
  return id as string;
}

export function toRawSymbolId(id: SymbolId): string {
  return id as string;
}

export function toRawVersionId(id: VersionId): string {
  return id as string;
}
