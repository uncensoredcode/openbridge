import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

const importLayoutRules = {
  "import/first": "error",
  "import/newline-after-import": [
    "error",
    {
      count: 1
    }
  ],
  "simple-import-sort/imports": "error",
  "padding-line-between-statements": [
    "error",
    {
      blankLine: "always",
      prev: "*",
      next: "export"
    }
  ]
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "bundle/**",
      "packages/*/dist/**",
      "packages/*/node_modules/**",
      "packages/*/*.tsbuildinfo",
      ".bridge-server/**",
      ".bridge-state/**",
      "packages/*/.bridge-server/**",
      "packages/*/.bridge-state/**",
      "*.log",
      "*.tgz",
      "bun.lock"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    plugins: {
      import: importPlugin,
      "simple-import-sort": simpleImportSort
    },
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-unused-vars": "off",
      ...importLayoutRules
    }
  },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommended],
    plugins: {
      import: importPlugin,
      "simple-import-sort": simpleImportSort
    },
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      ...importLayoutRules
    }
  }
);
