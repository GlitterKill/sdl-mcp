export type ScipGeneratedIndexMode = "merged" | "split";

export interface ScipGeneratedIndexDiagnostic {
  /** Repo-relative normalized path when generated inside the repo root. */
  path: string;
  label: string;
  sizeBytes: number;
  mode: ScipGeneratedIndexMode;
  contentHash?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface ScipFailureDiagnostic {
  stage:
    | "generator-detect"
    | "generator-install"
    | "generator-run"
    | "generator-select"
    | "generator-split-run"
    | "generator-split-select"
    | "ingest";
  message: string;
  path?: string;
  sizeBytes?: number;
}

