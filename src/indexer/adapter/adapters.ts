import { LANGUAGE_SUPPORT } from "../language-support.js";

/** Compatibility projection; built-in declarations live in Language Support. */
export const adapters = LANGUAGE_SUPPORT.flatMap((support) =>
  support.extensions.map((extension) => ({
    extension,
    languageId: support.language,
    factory: support.adapterFactory,
  })),
);
