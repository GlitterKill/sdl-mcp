import { extname } from "path";

import { getLanguageIdForExtension } from "../adapter/registry.js";
import type { FileMetadata } from "../fileScanner.js";

import { GoPass2Resolver } from "./resolvers/go-pass2-resolver.js";
import { JavaPass2Resolver } from "./resolvers/java-pass2-resolver.js";
import { KotlinPass2Resolver } from "./resolvers/kotlin-pass2-resolver.js";
import { PhpPass2Resolver } from "./resolvers/php-pass2-resolver.js";
import { PythonPass2Resolver } from "./resolvers/python-pass2-resolver.js";
import { RustPass2Resolver } from "./resolvers/rust-pass2-resolver.js";
import { TsPass2Resolver } from "./resolvers/ts-pass2-resolver.js";
import type { Pass2Resolver, Pass2Target } from "./types.js";

export interface Pass2ResolverRegistry {
  getResolver(target: Pass2Target): Pass2Resolver | undefined;
  supports(target: Pass2Target): boolean;
  listResolvers(): readonly Pass2Resolver[];
}

function normalizeExtension(filePath: string): string {
  return extname(filePath).toLowerCase();
}

function inferLanguage(filePath: string): string {
  const languageId = getLanguageIdForExtension(normalizeExtension(filePath));
  return languageId ?? "unknown";
}

export function toPass2Target(
  file: Pick<FileMetadata, "path"> &
    Partial<Pick<Pass2Target, "repoId" | "fileId">>,
): Pass2Target {
  return {
    repoId: file.repoId,
    fileId: file.fileId,
    filePath: file.path,
    extension: normalizeExtension(file.path),
    language: inferLanguage(file.path),
  };
}

export function createPass2ResolverRegistry(
  resolvers: readonly Pass2Resolver[],
): Pass2ResolverRegistry {
  return {
    getResolver(target) {
      return resolvers.find((resolver) => resolver.supports(target));
    },
    supports(target) {
      return resolvers.some((resolver) => resolver.supports(target));
    },
    listResolvers() {
      return [...resolvers];
    },
  };
}

export function createDefaultPass2ResolverRegistry(): Pass2ResolverRegistry {
  return createPass2ResolverRegistry([
    new TsPass2Resolver(),
    new GoPass2Resolver(),
    new JavaPass2Resolver(),
    new PhpPass2Resolver(),
    new PythonPass2Resolver(),
    new KotlinPass2Resolver(),
    new RustPass2Resolver(),
  ]);
}
