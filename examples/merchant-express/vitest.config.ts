import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The workspace packages from source, as tsconfig.json `paths` does for the typecheck.
const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "x402-ycash-mechanism": src("../../packages/ycash/src/index.ts"),
      "x402-ycash-facilitator": src("../../packages/facilitator/src/index.ts"),
    },
  },
});
