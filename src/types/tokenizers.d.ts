/**
 * Minimal ambient type declarations for the `tokenizers` napi-rs package.
 * The package ships its own types when installed, but since it's in optionalDependencies
 * and may not be present during development, we provide these minimal declarations
 * to keep TypeScript happy for dynamic imports.
 */
declare module "tokenizers" {
  export interface Encoding {
    getIds(): number[];
    getAttentionMask(): number[];
    getTypeIds(): number[];
    getTokens(): string[];
    getLength(): number;
  }

  export interface PaddingOptions {
    maxLength?: number;
    direction?: "left" | "right";
    padId?: number;
    padTypeId?: number;
    padToken?: string;
  }

  export interface EncodeOptions {
    isPretokenized?: boolean;
    addSpecialTokens?: boolean;
  }

  export class Tokenizer {
    static fromFile(path: string): Tokenizer;
    encode(
      sentence: string,
      pair?: string | null,
      options?: EncodeOptions,
    ): Promise<Encoding>;
    encodeBatch(
      sentences: string[],
      options?: EncodeOptions,
    ): Promise<Encoding[]>;
    setPadding(options?: PaddingOptions): void;
    disablePadding(): void;
    setTruncation(maxLength: number): void;
    disableTruncation(): void;
  }
}
