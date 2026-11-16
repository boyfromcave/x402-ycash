#!/usr/bin/env node
// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The entry point of the chain-data service (README "Run the paid API"). Exit 2 on a bad
// configuration or the wrong network, 1 on any other startup failure.
import { createServer } from "node:http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createChainApi } from "./app.js";
import { ConfigError, describeConfig, loadChainApiConfig, rpcOf, type ChainApiConfig } from "./config.js";
import { ChainReader } from "./reader.js";
import { checkNode, WrongNetworkError } from "./startup.js";

const log = (msg: string, fields?: Record<string, unknown>): void => console.log(JSON.stringify({ msg, ...fields }));

/** Headers carry the payment: a transparent transaction of a few hundred inputs fits in 64 KB. */
const MAX_HEADER_BYTES = 64 * 1024;

function facilitatorOf(config: ChainApiConfig): HTTPFacilitatorClient {
  const key = config.facilitatorApiKey;
  const auth = { Authorization: `Bearer ${key}` };
  return new HTTPFacilitatorClient({ url: config.facilitatorUrl, ...(key ? { createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }) } : {}) });
}

async function main(): Promise<void> {
  let config: ChainApiConfig;
  try {
    config = loadChainApiConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log("invalid configuration", { error: e.message });
      process.exit(2);
    }
    throw e;
  }
  const rpc = rpcOf(config);
  let facts;
  try {
    facts = await checkNode(rpc, config.network, config.testnetProfile, config.payTo, 120_000);
  } catch (e) {
    log("startup refused", { error: (e as Error).message });
    process.exit(e instanceof WrongNetworkError ? 2 : 1);
  }
  if (!facts.addressIndex) log("the node's address index is off: /v1/address answers 503 (start the node with -insightexplorer)");
  const api = createChainApi(config, { facilitator: facilitatorOf(config), reader: new ChainReader(rpc, { historyWindowBlocks: config.historyWindowBlocks }), addressIndex: facts.addressIndex, log });
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: 60_000, headersTimeout: 15_000 }, api.app);
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    log("chain api listening", { url: `http://${config.host}:${port}`, node: facts, config: describeConfig(config) });
  });
  const stop = (): void => {
    api.close();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
