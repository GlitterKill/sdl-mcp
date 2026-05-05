import { resolveTsCallEdgesPass2 } from "../../edge-builder/pass2.js";
import type { FileMetadata } from "../../fileScanner.js";

import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";

const TS_PASS2_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

type ResolveTsPass2Delegate = (params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  symbolIndex: Pass2ResolverContext["symbolIndex"];
  tsResolver: Pass2ResolverContext["tsResolver"];
  languages: Pass2ResolverContext["languages"];
  createdCallEdges: Pass2ResolverContext["createdCallEdges"];
  globalNameToSymbolIds?: Pass2ResolverContext["globalNameToSymbolIds"];
  globalPreferredSymbolId?: Pass2ResolverContext["globalPreferredSymbolId"];
  telemetry?: Pass2ResolverContext["telemetry"];
  mode?: Pass2ResolverContext["mode"];
  submitEdgeWrite?: Pass2ResolverContext["submitEdgeWrite"];
  importCache?: Pass2ResolverContext["importCache"];
  pass1Extractions?: Pass2ResolverContext["pass1Extractions"];
}) => Promise<number>;

export class TsPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-ts";

  constructor(
    private readonly resolveDelegate: ResolveTsPass2Delegate = resolveTsCallEdgesPass2,
  ) {}

  supports(target: Pass2Target): boolean {
    return (
      target.language === "typescript" &&
      TS_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("TsPass2Resolver requires target.repoId");
    }

    const edgesCreated = await this.resolveDelegate({
      repoId: target.repoId,
      repoRoot: context.repoRoot,
      fileMeta: {
        path: target.filePath,
        size: 0,
        mtime: 0,
      },
      symbolIndex: context.symbolIndex,
      tsResolver: context.tsResolver,
      languages: context.languages,
      createdCallEdges: context.createdCallEdges,
      globalNameToSymbolIds: context.globalNameToSymbolIds,
      globalPreferredSymbolId: context.globalPreferredSymbolId,
      telemetry: context.telemetry,
      mode: context.mode,
      submitEdgeWrite: context.submitEdgeWrite,
      importCache: context.importCache,
      pass1Extractions: context.pass1Extractions,
    });

    return { edgesCreated };
  }
}
