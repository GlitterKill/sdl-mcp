import { extname } from "path";

import type { FileMetadata } from "../fileScanner.js";
import { inferLanguageIdFromPath } from "../language.js";
import { createBuiltInPass2Resolvers } from "../language-support.js";

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
  return inferLanguageIdFromPath(filePath);
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
  return createPass2ResolverRegistry(createBuiltInPass2Resolvers());
}
