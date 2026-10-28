// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // see test/yield.setup.ts: keeps the worker's RPC answered between CPU-heavy post-quantum tests
    setupFiles: ["./test/yield.setup.ts"],
  },
});
