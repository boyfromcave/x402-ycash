// Lint for every workspace, after the upstream mechanisms' config
// (x402 typescript/packages/mechanisms/cardano/eslint.config.js): typescript-eslint's recommended
// rules, the same complexity ceilings, import order and JSDoc hygiene. packages/ycash/src is staged
// into x402 as @x402/ycash (tools/upstream/stage.sh), so it also carries upstream's full rule set:
// JSDoc with @param/@returns on every function, method and class, member-ordering, and `_` as the
// only unused-argument name. Keep that block equal to tools/upstream/overlay/package/eslint.config.js
// minus prettier: this repository wraps at ~160 columns, and the stage step formats for upstream.
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
    // Upstream's mechanism rules (cardano/eslint.config.js), on the code that is staged upstream.
    files: ["packages/ycash/src/**/*.ts"],
    // TODO(coordinator): after rehearse merges, document these two and drop this ignore.
    ignores: ["packages/ycash/src/shielded/server.ts", "packages/ycash/src/shielded/registry.ts"],
    rules: {
      "@typescript-eslint/member-ordering": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_$", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "jsdoc/no-undefined-types": "off",
      "jsdoc/check-types": "error",
      "jsdoc/implements-on-classes": "error",
      "jsdoc/require-description": "error",
      "jsdoc/require-jsdoc": [
        "error",
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      "jsdoc/require-param": "error",
      "jsdoc/require-param-description": "error",
      "jsdoc/require-param-type": "off",
      "jsdoc/require-returns": "error",
      "jsdoc/require-returns-description": "error",
      "jsdoc/require-returns-type": "off",
      "jsdoc/require-hyphen-before-param-description": ["error", "always"],
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
