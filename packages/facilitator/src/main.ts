#!/usr/bin/env node
// The facilitator service entry point: `x402-ycash-facilitator` (see the README's "Facilitator").
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { installSignalHandlers, startFacilitator } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      createLogger("error").error("invalid configuration", { error: e.message });
      process.exit(2);
    }
    throw e;
  }
  const logger = createLogger(config.logLevel, { service: "x402-ycash-facilitator" });
  try {
    const running = await startFacilitator(config, { logger });
    installSignalHandlers(running, logger);
  } catch (e) {
    logger.error("startup failed", { error: e });
    process.exit(1);
  }
}

void main();
