import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "exact/client/index": "src/exact/client/index.ts",
    "exact/server/index": "src/exact/server/index.ts",
    "exact/facilitator/index": "src/exact/facilitator/index.ts",
    "batch-settlement/client/index": "src/batch-settlement/client/index.ts",
    "batch-settlement/server/index": "src/batch-settlement/server/index.ts",
    "batch-settlement/facilitator/index": "src/batch-settlement/facilitator/index.ts",
  },
  dts: {
    resolve: true,
  },
  sourcemap: true,
  target: "es2020",
  // src/lwd finds its vendored protos from import.meta.url, which the CJS build must shim
  shims: true,
};

export default defineConfig([
  {
    ...baseConfig,
    format: "esm",
    outDir: "dist/esm",
    clean: true,
  },
  {
    ...baseConfig,
    format: "cjs",
    outDir: "dist/cjs",
    clean: false,
    dts: false,
  },
]);
