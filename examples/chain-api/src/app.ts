// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The chain-data API: paid reads of a Ycash node for agents, each paid per request in transparent
// YEC through x402 (`exact`, settled by the facilitator). The order of the Express stack is the
// security design:
//   1. rate limits per client address: free routes, unpaid requests (each 402 costs us a challenge)
//      and paid attempts (each costs the facilitator a verify) are counted apart;
//   2. the free routes (/, /pricing, /healthz), which never call the node per request;
//   3. per-route parameter checks: a bad request is a 400 before any payment or node work;
//   4. the payment middleware, which answers 402, or verifies the payment with the facilitator
//      before the handler runs and settles it only if the handler answered < 400;
//   5. the handler, which reads the node through ChainReader (fixed RPC method names).
// A handler is reachable only through the payment check: the guard asks the same route table the
// middleware uses and refuses (404) any path variant it would not charge for.
import express from "express";
import { rateLimit } from "express-rate-limit";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import { ExpressAdapter, paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/express";
import { ASSET_YEC, exact } from "x402-ycash-mechanism";
import { broadcastHexOf, invalidParams, patternOf, priceOf, ROUTES, yecOf, type PaidRoute } from "./catalog.js";
import type { ChainApiConfig } from "./config.js";
import { ApiError, apiErrorOf, type ChainReader } from "./reader.js";

export interface ChainApiOptions {
  facilitator: FacilitatorClient;
  reader: ChainReader;
  /**
   * Whether the node keeps the address index (-insightexplorer), found at startup (main.ts). Off,
   * the address route answers 503 before any payment; the other routes are unaffected.
   */
  addressIndex?: boolean;
  /** Health poll interval, ms (default 15 s); 0 = no background poll (tests call `health.check()`). */
  healthPollMs?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface Health {
  ok: boolean;
  tip: number | null;
  checkedAt: number | null;
  check(): Promise<void>;
}

export interface ChainApi {
  app: express.Express;
  health: Health;
  close(): void;
}

/** Seconds a client has to sign and send a payment for a challenge. */
const MAX_TIMEOUT_SECONDS = 300;
/** /healthz says unhealthy when the last good node answer is older than this. */
const HEALTH_STALE_MS = 60_000;

function routesConfig(config: ChainApiConfig): RoutesConfig {
  const all: RoutesConfig = {};
  for (const r of ROUTES) {
    all[patternOf(r)] = {
      accepts: {
        scheme: "exact",
        network: config.network,
        payTo: config.payTo,
        price: { amount: priceOf(r, config).toString(), asset: ASSET_YEC, extra: { assetTransferMethod: "transparent" } },
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      },
      description: r.description,
      mimeType: "application/json",
    };
  }
  return all;
}

/**
 * The machine-readable price list served free at / and /pricing.
 *
 * @param config - The configuration.
 * @returns The document.
 */
export function pricingDocument(config: ChainApiConfig, features: { addressIndex?: boolean } = {}): Record<string, unknown> {
  return {
    service: "Ycash chain data for agents, paid per request over x402",
    network: config.network,
    ...(config.testnetProfile ? { testnetProfile: config.testnetProfile, note: "the Ycash fast testnet: its coins have no value; get some from the faucet" } : {}),
    asset: ASSET_YEC,
    decimals: 8,
    payTo: config.payTo,
    payment: {
      protocol: "x402 version 2 (HTTP 402 Payment Required)",
      kinds: [
        {
          scheme: "exact",
          assetTransferMethod: "transparent",
          description: "the client signs a whole transparent transaction paying payTo the route's price; the facilitator checks it and relays it",
          settlement:
            config.zeroConfCapZat >= config.priceZat
              ? `on mempool acceptance (about a second) for payments up to ${config.zeroConfCapZat} zatoshis; otherwise after one block`
              : "after one block",
        },
      ],
      flow: [
        "request the route: the answer is 402 with the price in the PAYMENT-REQUIRED header (base64 JSON)",
        "sign a payment for one of its `accepts` and repeat the request with it in the PAYMENT-SIGNATURE header",
        "the answer is the data, with the settlement (txid) in the PAYMENT-RESPONSE header",
      ],
      rules: [
        "one payment buys one request: a replayed payment is refused",
        "a request answered with an error (4xx or 5xx) is not settled, so not charged",
        "bad parameters are refused with 400 before any payment",
      ],
      clients: "x402-ycash (CLI, `x402-ycash pay <url> --lwd <host:port> --wif-file <key>`) or any x402 client with the Ycash `exact` scheme",
    },
    routes: ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      priceZat: priceOf(r, config).toString(),
      priceYec: yecOf(priceOf(r, config)),
      description: r.description,
      params: r.params,
      example: r.example,
      ...(r.id === "address" && features.addressIndex === false ? { available: false, unavailableReason: "the node's address index is off" } : {}),
    })),
    free: [
      { method: "GET", path: "/", description: "this document" },
      { method: "GET", path: "/pricing", description: "this document" },
      { method: "GET", path: "/healthz", description: "whether the API reaches its node" },
    ],
    limits: {
      unpaidRequestsPerMinute: config.limits.unpaidPerMinute,
      paidRequestsPerMinute: config.limits.paidPerMinute,
      freeRequestsPerMinute: config.limits.freePerMinute,
      addressHistoryBlocks: config.historyWindowBlocks,
      listEntries: 100,
    },
    links: config.links,
  };
}

function limiter(perMinute: number, skip: (req: express.Request) => boolean, what: string): express.RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    handler: (_req, res) => {
      res.status(429).json({ error: "rate_limited", message: `too many ${what} requests from this address; wait a minute` });
    },
  });
}

/**
 * Whether a request carries a decodable payment, so it is counted against the paid limit; a junk
 * header is counted as unpaid (it gets a 402 like a request without one).
 *
 * @param req - The request.
 * @returns True for a PAYMENT-SIGNATURE that decodes as an x402 payment payload.
 */
function hasPayment(req: express.Request): boolean {
  const h = req.get("payment-signature") ?? req.get("x-payment");
  if (h === undefined) return false;
  try {
    const p = decodePaymentSignatureHeader(h) as { x402Version?: unknown; accepted?: unknown };
    return typeof p.x402Version === "number" && typeof p.accepted === "object" && p.accepted !== null;
  } catch {
    return false;
  }
}

function sendError(res: express.Response, e: ApiError): void {
  res.status(e.status).json({ error: e.code, message: e.message });
}

function handlerOf(route: PaidRoute, reader: ChainReader): express.RequestHandler {
  return async (req, res) => {
    let body: unknown;
    try {
      switch (route.id) {
        case "tx":
          body = await reader.transaction((req.params.txid as string).toLowerCase());
          break;
        case "address":
          body = await reader.address(req.params.address as string);
          break;
        case "block":
          body = await reader.block((req.params.id as string).toLowerCase());
          break;
        case "chain":
          body = await reader.chain();
          break;
        case "yellowback":
          body = await reader.yellowback();
          break;
        case "broadcast": {
          const parsed = broadcastHexOf(req.body);
          if ("error" in parsed) throw new ApiError(400, "bad_request", parsed.error);
          body = await reader.broadcast(parsed.hex);
          break;
        }
      }
    } catch (e) {
      sendError(res, apiErrorOf(e, route.id));
      return;
    }
    res.json(body);
  };
}

/**
 * Builds the API. The caller owns the HTTP server (main.ts sets its header and time limits).
 *
 * @param config - The configuration.
 * @param opts - The facilitator client, the node reader, the health poll.
 * @returns The Express app, the health state and a close function.
 */
export function createChainApi(config: ChainApiConfig, opts: ChainApiOptions): ChainApi {
  const log = opts.log ?? ((msg: string, fields?: Record<string, unknown>): void => console.log(JSON.stringify({ msg, ...fields })));
  const resourceServer = new x402ResourceServer(opts.facilitator);
  resourceServer.register(config.network, new exact.ExactYcashServerScheme({ zeroConfCapZat: config.zeroConfCapZat }));
  const httpServer = new x402HTTPResourceServer(resourceServer, routesConfig(config));
  const pay = paymentMiddlewareFromHTTPServer(httpServer);
  // Fail closed: run the payment middleware only on a path it charges for; anything else is a 404.
  const guard: express.RequestHandler = (req, res, next) => {
    let decodedPath = req.path;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      // keep the raw path
    }
    if (!httpServer.requiresPayment({ adapter: new ExpressAdapter(req), path: req.path, decodedPath, method: req.method })) {
      res.status(404).json({ error: "not_found", message: "no such route; see /pricing" });
      return;
    }
    void pay(req, res, next);
  };

  const health: Health = {
    ok: false,
    tip: null,
    checkedAt: null,
    async check() {
      try {
        this.tip = await opts.reader.tip();
        this.ok = true;
        this.checkedAt = Date.now();
      } catch (e) {
        if (this.ok) log("node unreachable", { error: (e as Error).message });
        this.ok = false;
      }
    },
  };
  const pollMs = opts.healthPollMs ?? 15_000;
  const timer = pollMs > 0 ? setInterval(() => void health.check(), pollMs) : undefined;
  timer?.unref();
  if (pollMs > 0) void health.check();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // 1-2: the free routes, with their own limit; no node call per request.
  const free = limiter(config.limits.freePerMinute, () => false, "free");
  const pricing = pricingDocument(config, { ...(opts.addressIndex !== undefined ? { addressIndex: opts.addressIndex } : {}) });
  app.get(["/", "/pricing"], free, (_req, res) => {
    res.json(pricing);
  });
  app.get("/healthz", free, (_req, res) => {
    const fresh = health.ok && health.checkedAt !== null && Date.now() - health.checkedAt < HEALTH_STALE_MS;
    res.status(fresh ? 200 : 503).json({ ok: fresh, network: config.network, tip: health.tip });
  });

  // 1: the paid surface's limits, unpaid and paid counted apart.
  app.use("/v1", limiter(config.limits.unpaidPerMinute, hasPayment, "unpaid"), limiter(config.limits.paidPerMinute, (req) => !hasPayment(req), "paid"));

  // 3-5: per route, check the parameters, then the payment, then read the node.
  for (const r of ROUTES) {
    const check: express.RequestHandler = (req, res, next) => {
      if (r.id === "broadcast") {
        const parsed = broadcastHexOf(req.body);
        if ("error" in parsed) return void res.status(400).json({ error: "bad_request", message: parsed.error });
        return next();
      }
      if (r.id === "address" && opts.addressIndex === false) {
        return void res.status(503).json({ error: "index_off", message: "address lookups need the node's address index (-insightexplorer), which is off on this node; nothing was charged" });
      }
      const reason = invalidParams(r.id, req.params as Record<string, string>, config.network);
      if (reason) return void res.status(400).json({ error: "bad_request", message: reason });
      next();
    };
    const chain: express.RequestHandler[] = r.method === "POST" ? [express.json({ limit: "256kb", strict: true }), check, guard, handlerOf(r, opts.reader)] : [check, guard, handlerOf(r, opts.reader)];
    if (r.method === "POST") app.post(r.path, ...chain);
    else app.get(r.path, ...chain);
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "no such route; see /pricing" });
  });
  // Body-parser errors (too large, bad JSON) and anything unexpected: a short answer, no stack.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status >= 400 && status < 500) return void res.status(status).json({ error: "bad_request", message: status === 413 ? "the body is too large" : "the body is not valid JSON" });
    log("internal error", { error: (err as Error).message });
    res.status(500).json({ error: "internal", message: "internal error" });
  });

  return {
    app,
    health,
    close: () => {
      if (timer) clearInterval(timer);
    },
  };
}
