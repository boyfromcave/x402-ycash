import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against the mechanism's source, as the typecheck does (tsconfig.json `paths`).
export default defineConfig({
  resolve: {
    alias: { "x402-ycash-mechanism": fileURLToPath(new URL("../ycash/src/index.ts", import.meta.url)) },
  },
});
