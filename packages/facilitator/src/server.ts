// Startup and graceful shutdown: config → node (wait, chain check) → stores → schemes → listen.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { x402Facilitator } from "@x402/core/facilitator";
import { FileChannelStore, FileIssuedAddressRegistry, FileSettlementStore, shielded } from "x402-ycash-mechanism";
import { createApp } from "./app.js";
import { redactConfig, type FacilitatorConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { assertViewingKeyNode, createRpc, waitForNode } from "./node.js";
import { registerSchemes, type SchemeDeps } from "./schemes.js";

export interface RunningFacilitator {
  server: Server;
  /** The bound URL, e.g. http://127.0.0.1:4022 (port 0 in config picks a free one). */
  url: string;
  facilitator: x402Facilitator;
  /** Stops accepting, lets in-flight requests finish (up to shutdownTimeoutMs), then closes. */
  close(): Promise<void>;
}

export interface StartOptions {
  logger?: Logger;
  /**
   * Replaces `registerSchemes` (tests register a fake mechanism here). Production leaves it unset.
   */
  register?: (facilitator: x402Facilitator, deps: SchemeDeps) => string[];
}

export async function startFacilitator(config: FacilitatorConfig, opts: StartOptions = {}): Promise<RunningFacilitator> {
  const logger = opts.logger ?? createLogger(config.logLevel, { service: "x402-ycash-facilitator" });
  logger.info("starting", { config: redactConfig(config) });

  const rpc = createRpc(config.rpc);
  const capabilities = await waitForNode(rpc, config.network, config.nodeWaitMs, logger);
  logger.info("node ready", { line: capabilities.line, chain: capabilities.chain, subversion: capabilities.subversion, yellowback: capabilities.yellowback });

  const settlementStore = new FileSettlementStore(config.settlementStorePath);
  const facilitator = new x402Facilitator();
  const sp = config.saplingProof;
  const oi = sp?.offlineIssuer;
  const issuer = oi ? new shielded.OfflineAddressIssuer({ viewingKey: oi.viewingKey, network: config.network, startIndex: oi.startIndex, indexPath: oi.indexPath }) : undefined;
  if (issuer) await assertViewingKeyNode(rpc, issuer.defaultAddress(), logger);
  const deps: SchemeDeps = {
    network: config.network,
    rpc,
    settlementStore,
    confirmations: config.confirmations,
    capabilities,
    logger,
    channelStore: new FileChannelStore(config.channelStorePath),
    ...(sp
      ? {
          saplingProof: {
            methods: sp.methods,
            receiptKey: sp.receiptKey,
            registry: new FileIssuedAddressRegistry(sp.registryPath),
            ...(sp.baseAddress ? { baseAddress: sp.baseAddress } : {}),
            ...(sp.noteWaitMs !== undefined ? { noteWaitMs: sp.noteWaitMs } : {}),
            ...(issuer ? { issuer } : {}),
            // sapling reuses the offline issuer's viewing key for trial decryption.
            ...(oi ? { viewingKey: oi.viewingKey } : {}),
          },
        }
      : {}),
  };
  const registered = (opts.register ?? registerSchemes)(facilitator, deps);
  logger.info("schemes registered", { schemes: registered, kinds: facilitator.getSupported().kinds.length });
  if (registered.length === 0) logger.warn("no scheme registered: /verify and /settle answer unsupported_scheme");

  const handle = createApp({
    facilitator,
    network: config.network,
    node: rpc,
    confirmations: config.confirmations,
    logger,
    bodyLimit: config.bodyLimit,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = handle.app.listen(config.port, config.host, () => resolve(s));
    s.once("error", reject);
  });
  // A request that stalls mid-body must not pin a socket forever.
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  const url = `http://${host}:${addr.port}`;
  logger.info("listening", { url });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      logger.info("shutting down", { inFlight: handle.inFlight() });
      handle.beginShutdown();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      const deadline = Date.now() + config.shutdownTimeoutMs;
      while (handle.inFlight() > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      if (handle.inFlight() > 0) logger.warn("shutdown timeout: closing with requests in flight", { inFlight: handle.inFlight() });
      server.closeAllConnections();
      await closed;
      logger.info("stopped");
    })());

  return { server, url, facilitator, close };
}

/** SIGTERM / SIGINT → graceful close, then exit. A second signal exits at once. */
export function installSignalHandlers(running: RunningFacilitator, logger: Logger): void {
  let signalled = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) {
      logger.warn("second signal, exiting now", { signal });
      process.exit(1);
    }
    signalled = true;
    logger.info("signal received", { signal });
    running.close().then(
      () => process.exit(0),
      (e: unknown) => {
        logger.error("shutdown failed", { error: e });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
