export interface ResolveImportCandidatePathsParams {
  language: string;
  repoRoot: string;
  importerRelPath: string;
  specifier: string;
  extensions: string[];
  knownRepoPaths?: { has(relPath: string): boolean };
}

export interface ImportResolutionAdapter {
  readonly id: string;
  supports(language: string): boolean;
  resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]>;
}
