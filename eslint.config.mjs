import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "scripts/*.js", "src/ui/*.js"],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      "import-x": importX,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import-x/resolver": {
        node: {
          extensions: [".ts", ".js", ".mjs"],
        },
      },
      "import-x/parsers": {
        "@typescript-eslint/parser": [".ts"],
      },
    },
    rules: {
      "import-x/extensions": ["error", "ignorePackages"],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "no-console": "off",
      "prefer-const": "warn",
      "no-empty": "warn",
      "no-case-declarations": "off",
      "no-useless-escape": "off",
    },
  }
);
