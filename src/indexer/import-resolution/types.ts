export interface ResolveImportCandidatePathsParams {
  language: string;
  repoRoot: string;
  importerRelPath: string;
  specifier: string;
  extensions: string[];
  knownRepoPaths?: {
    has(relPath: string): boolean;
    keys?: () => Iterable<string>;
  };
  ignorePatterns?: string[];
}

export interface ImportResolutionAdapter {
  readonly id: string;
  supports(language: string): boolean;
  resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]>;
}
