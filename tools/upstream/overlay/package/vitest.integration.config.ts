import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// The in-process flows (exact-ycash, batch-settlement-ycash) always run. The *.devnet.test.ts
// suites run against a Ycash regtest devnet named by X402_DEVNET_JSON and are skipped without it
// (Ycash testnet has no reachable seeds; see the package README, "Testing").
export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    include: ["**/test/integrations/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
