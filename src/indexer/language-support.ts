import type {
  LanguageAdapter,
  StructuralMatcherDescriptor,
} from "./adapter/LanguageAdapter.js";
import { CAdapter } from "./adapter/c.js";
import { CppAdapter } from "./adapter/cpp.js";
import { CSharpAdapter } from "./adapter/csharp.js";
import { GoAdapter } from "./adapter/go.js";
import { JavaAdapter } from "./adapter/java.js";
import { KotlinAdapter } from "./adapter/kotlin.js";
import { PhpAdapter } from "./adapter/php.js";
import { PythonAdapter } from "./adapter/python.js";
import { RustAdapter } from "./adapter/rust.js";
import { ShellAdapter } from "./adapter/shell.js";
import { TypeScriptAdapter } from "./adapter/typescript.js";
import { CIncludeImportResolutionAdapter } from "./import-resolution/c-include-adapter.js";
import { CSharpImportResolutionAdapter } from "./import-resolution/csharp-adapter.js";
import { GoImportResolutionAdapter } from "./import-resolution/go-adapter.js";
import { JavaKotlinImportResolutionAdapter } from "./import-resolution/java-kotlin-adapter.js";
import { PhpImportResolutionAdapter } from "./import-resolution/php-adapter.js";
import { PythonImportResolutionAdapter } from "./import-resolution/python-adapter.js";
import { RustImportResolutionAdapter } from "./import-resolution/rust-adapter.js";
import { ShellImportResolutionAdapter } from "./import-resolution/shell-adapter.js";
import type { ImportResolutionAdapter } from "./import-resolution/types.js";
import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "./pass2/types.js";
import type { SupportedLanguage } from "./treesitter/grammarLoader.js";

export type BuiltInLanguage =
  | "typescript"
  | "go"
  | "java"
  | "php"
  | "python"
  | "kotlin"
  | "rust"
  | "csharp"
  | "cpp"
  | "c"
  | "shell";

type ImportCandidatesFactory = () => ImportResolutionAdapter;
type Pass2ResolverLoader = () => Promise<Pass2Resolver>;

export interface LanguageSupport {
  language: BuiltInLanguage;
  extensions: readonly string[];
  grammarKey: SupportedLanguage;
  adapterFactory: () => LanguageAdapter;
  importCandidatesFactory?: ImportCandidatesFactory;
  /** Preserves the established first-match order in the runtime registry. */
  importCandidatesOrder?: number;
  pass2ResolverFactory: () => Pass2Resolver;
  structuralMatcher?: StructuralMatcherDescriptor;
}

const createCImportCandidates = (): ImportResolutionAdapter =>
  new CIncludeImportResolutionAdapter();
const createGoImportCandidates = (): ImportResolutionAdapter =>
  new GoImportResolutionAdapter();
const createCSharpImportCandidates = (): ImportResolutionAdapter =>
  new CSharpImportResolutionAdapter();
const createJavaImportCandidates = (): ImportResolutionAdapter =>
  new JavaKotlinImportResolutionAdapter();
const createRustImportCandidates = (): ImportResolutionAdapter =>
  new RustImportResolutionAdapter();
const createPythonImportCandidates = (): ImportResolutionAdapter =>
  new PythonImportResolutionAdapter();
const createPhpImportCandidates = (): ImportResolutionAdapter =>
  new PhpImportResolutionAdapter();
const createShellImportCandidates = (): ImportResolutionAdapter =>
  new ShellImportResolutionAdapter();

/**
 * Defers concrete pass-2 modules until a supported target actually runs.
 * This keeps Language Support as the ownership table without introducing a
 * static import cycle through resolvers that depend on the adapter registry.
 */
class LazyPass2Resolver implements Pass2Resolver {
  private resolverPromise?: Promise<Pass2Resolver>;

  constructor(
    readonly id: string,
    private readonly language: BuiltInLanguage,
    private readonly loadResolver: Pass2ResolverLoader,
  ) {}

  supports(target: Pass2Target): boolean {
    if (target.language !== this.language) return false;
    const support = LANGUAGE_SUPPORT.find(
      (candidate) => candidate.language === this.language,
    );
    return support?.extensions.includes(target.extension) ?? false;
  }

  async warmup(
    targets: readonly Pass2Target[],
    context: Pass2ResolverContext,
  ): Promise<void> {
    const resolver = await this.getResolver();
    await resolver.warmup?.(targets, context);
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    return (await this.getResolver()).resolve(target, context);
  }

  private getResolver(): Promise<Pass2Resolver> {
    this.resolverPromise ??= this.loadResolver();
    return this.resolverPromise;
  }
}

const loadTsPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { TsPass2Resolver } = await import(
    "./pass2/resolvers/ts-pass2-resolver.js"
  );
  return new TsPass2Resolver();
};
const loadGoPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { GoPass2Resolver } = await import(
    "./pass2/resolvers/go-pass2-resolver.js"
  );
  return new GoPass2Resolver();
};
const loadJavaPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { JavaPass2Resolver } = await import(
    "./pass2/resolvers/java-pass2-resolver.js"
  );
  return new JavaPass2Resolver();
};
const loadPhpPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { PhpPass2Resolver } = await import(
    "./pass2/resolvers/php-pass2-resolver.js"
  );
  return new PhpPass2Resolver();
};
const loadPythonPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { PythonPass2Resolver } = await import(
    "./pass2/resolvers/python-pass2-resolver.js"
  );
  return new PythonPass2Resolver();
};
const loadKotlinPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { KotlinPass2Resolver } = await import(
    "./pass2/resolvers/kotlin-pass2-resolver.js"
  );
  return new KotlinPass2Resolver();
};
const loadRustPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { RustPass2Resolver } = await import(
    "./pass2/resolvers/rust-pass2-resolver.js"
  );
  return new RustPass2Resolver();
};
const loadCSharpPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { CSharpPass2Resolver } = await import(
    "./pass2/resolvers/csharp-pass2-resolver.js"
  );
  return new CSharpPass2Resolver();
};
const loadCppPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { CppPass2Resolver } = await import(
    "./pass2/resolvers/cpp-pass2-resolver.js"
  );
  return new CppPass2Resolver();
};
const loadCPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { CPass2Resolver } = await import(
    "./pass2/resolvers/c-pass2-resolver.js"
  );
  return new CPass2Resolver();
};
const loadShellPass2Resolver = async (): Promise<Pass2Resolver> => {
  const { ShellPass2Resolver } = await import(
    "./pass2/resolvers/shell-pass2-resolver.js"
  );
  return new ShellPass2Resolver();
};

function createLazyPass2Resolver(
  id: string,
  language: BuiltInLanguage,
  loader: Pass2ResolverLoader,
): Pass2Resolver {
  return new LazyPass2Resolver(id, language, loader);
}

/**
 * Built-in language registrations. All constructors remain behind factories;
 * plugin-provided adapters continue to overlay these defaults at runtime.
 */
export const LANGUAGE_SUPPORT: readonly LanguageSupport[] = Object.freeze([
  {
    language: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    grammarKey: "typescript",
    adapterFactory: () => new TypeScriptAdapter(),
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-ts",
        "typescript",
        loadTsPass2Resolver,
      ),
  },
  {
    language: "go",
    extensions: [".go"],
    grammarKey: "go",
    adapterFactory: () => new GoAdapter(),
    importCandidatesFactory: createGoImportCandidates,
    importCandidatesOrder: 1,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver("pass2-go", "go", loadGoPass2Resolver),
  },
  {
    language: "java",
    extensions: [".java"],
    grammarKey: "java",
    adapterFactory: () => new JavaAdapter(),
    importCandidatesFactory: createJavaImportCandidates,
    importCandidatesOrder: 3,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-java",
        "java",
        loadJavaPass2Resolver,
      ),
  },
  {
    language: "php",
    extensions: [".php", ".phtml"],
    grammarKey: "php",
    adapterFactory: () => new PhpAdapter(),
    importCandidatesFactory: createPhpImportCandidates,
    importCandidatesOrder: 6,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-php",
        "php",
        loadPhpPass2Resolver,
      ),
  },
  {
    language: "python",
    extensions: [".py", ".pyw"],
    grammarKey: "python",
    adapterFactory: () => new PythonAdapter(),
    importCandidatesFactory: createPythonImportCandidates,
    importCandidatesOrder: 5,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-python",
        "python",
        loadPythonPass2Resolver,
      ),
  },
  {
    language: "kotlin",
    extensions: [".kt", ".kts"],
    grammarKey: "kotlin",
    adapterFactory: () => new KotlinAdapter(),
    importCandidatesFactory: createJavaImportCandidates,
    importCandidatesOrder: 3,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-kotlin",
        "kotlin",
        loadKotlinPass2Resolver,
      ),
  },
  {
    language: "rust",
    extensions: [".rs"],
    grammarKey: "rust",
    adapterFactory: () => new RustAdapter(),
    importCandidatesFactory: createRustImportCandidates,
    importCandidatesOrder: 4,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-rust",
        "rust",
        loadRustPass2Resolver,
      ),
  },
  {
    language: "csharp",
    extensions: [".cs"],
    grammarKey: "csharp",
    adapterFactory: () => new CSharpAdapter(),
    importCandidatesFactory: createCSharpImportCandidates,
    importCandidatesOrder: 2,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-csharp",
        "csharp",
        loadCSharpPass2Resolver,
      ),
  },
  {
    language: "cpp",
    extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    grammarKey: "cpp",
    adapterFactory: () => new CppAdapter(),
    importCandidatesFactory: createCImportCandidates,
    importCandidatesOrder: 0,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-cpp",
        "cpp",
        loadCppPass2Resolver,
      ),
  },
  {
    language: "c",
    extensions: [".c", ".h"],
    grammarKey: "c",
    adapterFactory: () => new CAdapter(),
    importCandidatesFactory: createCImportCandidates,
    importCandidatesOrder: 0,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver("pass2-c", "c", loadCPass2Resolver),
  },
  {
    language: "shell",
    extensions: [".sh", ".bash", ".zsh"],
    grammarKey: "bash",
    adapterFactory: () => new ShellAdapter(),
    importCandidatesFactory: createShellImportCandidates,
    importCandidatesOrder: 7,
    pass2ResolverFactory: () =>
      createLazyPass2Resolver(
        "pass2-shell",
        "shell",
        loadShellPass2Resolver,
      ),
  },
]);

/** Construct the established eight shared import-candidate adapters in order. */
export function createBuiltInImportResolutionAdapters(): ImportResolutionAdapter[] {
  const seen = new Set<ImportCandidatesFactory>();
  return [...LANGUAGE_SUPPORT]
    .filter(
      (support): support is LanguageSupport & {
        importCandidatesFactory: ImportCandidatesFactory;
        importCandidatesOrder: number;
      } =>
        support.importCandidatesFactory !== undefined
        && support.importCandidatesOrder !== undefined,
    )
    .sort((left, right) =>
      left.importCandidatesOrder - right.importCandidatesOrder,
    )
    .flatMap((support) => {
      if (seen.has(support.importCandidatesFactory)) return [];
      seen.add(support.importCandidatesFactory);
      return [support.importCandidatesFactory()];
    });
}

/** Construct one pass-2 resolver per built-in language in stable order. */
export function createBuiltInPass2Resolvers(): Pass2Resolver[] {
  return LANGUAGE_SUPPORT.map((support) => support.pass2ResolverFactory());
}
