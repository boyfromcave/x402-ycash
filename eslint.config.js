// Lint for every workspace, after the upstream mechanisms' config
// (x402 typescript/packages/mechanisms/cardano/eslint.config.js): typescript-eslint's recommended
// rules, the same complexity ceilings, import order and JSDoc hygiene. Two upstream rules are left
// out on purpose: prettier (this repository wraps at ~160 columns, and a reformat of every file
// would collide with every open branch) and jsdoc/require-jsdoc on every function (the code
// documents its exports and its non-obvious rules, in prose), and @typescript-eslint/member-ordering
// (76 moves across files other branches are editing; revisit once they have merged).
import js from "@eslint/js";
import ts from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import sonarjs from "eslint-plugin-sonarjs";

const nodeGlobals = {
  process: "readonly",
  Buffer: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  structuredClone: "readonly",
  fetch: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
  URL: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  performance: "readonly",
  NodeJS: "readonly",
};

const shared = {
  ...ts.configs.recommended.rules,
  "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
  complexity: ["error", 80],
  "max-lines": ["error", { max: 2000 }],
  "sonarjs/cognitive-complexity": ["error", 110],
  "import/first": "error",
  "import/no-duplicates": "error",
  "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
  eqeqeq: ["error", "always"],
  curly: ["error", "multi-line"],
};

export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser, sourceType: "module", ecmaVersion: 2022, globals: nodeGlobals },
    plugins: { "@typescript-eslint": ts, import: importPlugin, jsdoc, sonarjs },
    rules: {
      ...shared,
      // TypeScript checks these itself (and knows the DOM/Node types eslint's core rules do not).
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
      "jsdoc/check-alignment": "error",
      "jsdoc/check-param-names": "error",
      "jsdoc/check-tag-names": "error",
      "jsdoc/tag-lines": ["error", "any", { startLines: 1 }],
    },
  },
  {
    files: ["**/test/**/*.ts", "**/*.test.ts", "vectors/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { sourceType: "module", ecmaVersion: 2022, globals: nodeGlobals },
  },
];
