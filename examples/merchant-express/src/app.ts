// The merchant: one paid route per payment mode, behind @x402/express's paymentMiddleware, which
// answers 402 with PAYMENT-REQUIRED, reads PAYMENT-SIGNATURE, calls the facilitator's /verify and
// /settle, and returns PAYMENT-RESPONSE (specs/transports-v2/http.md).
import express from "express";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ASSET_YEC } from "x402-ycash-mechanism";
import type { MerchantConfig } from "./config.js";
import { registerServerSchemes, type PaymentModes, type RegisterServerSchemes, type ServerSchemes, type YedModes } from "./schemes.js";

export interface MerchantOptions {
  /** Defaults to an HTTPFacilitatorClient on `config.facilitatorUrl`. */
  facilitator?: FacilitatorClient;
  /** Defaults to schemes.ts; tests pass a fake. */
  register?: RegisterServerSchemes;
  /** The YED modes probeYed (yed.ts) found; absent, the YED routes answer 501. */
  yed?: YedModes;
}

export interface Merchant {
  app: express.Express;
  modes: PaymentModes;
  /** Stops the schemes' background work (the channel watcher); the HTTP server is the caller's. */
  close(): Promise<void>;
}

/** The paid routes, keyed as paymentMiddleware wants them ("VERB /path"). */
export const PAID_ROUTES = {
  exact: "GET /exact/quote",
  ticker: "GET /exact/ticker",
  channel: "GET /channel/search",
  shielded: "GET /shielded/report",
  yedReport: "GET /yed/report",
  yedStream: "GET /yed/stream",
} as const;
export type PaidRoute = keyof typeof PAID_ROUTES;

/** The payment mode each route needs. */
export const MODE_OF: Readonly<Record<PaidRoute, keyof PaymentModes>> = {
  exact: "exact",
  ticker: "exact",
  channel: "channel",
  shielded: "shielded",
  yedReport: "yedExact",
  yedStream: "yedChannel",
};

function routes(config: MerchantConfig, schemes: ServerSchemes): RoutesConfig {
  const { network, payTo } = config;
  const { modes } = schemes;
  const all: RoutesConfig = {};
  if (modes.exact) {
    all[PAID_ROUTES.exact] = {
      accepts: {
        scheme: "exact",
        network,
        payTo,
        price: { amount: config.priceExactZat, asset: ASSET_YEC, extra: { assetTransferMethod: "transparent" } },
        maxTimeoutSeconds: 300,
      },
      description: "One quote, paid per request in transparent YEC",
      mimeType: "application/json",
    };
    // Priced at or below the zero-confirmation cap, so served on mempool acceptance (policy −1)
    // when the facilitator settles from the mempool; otherwise at its minimum.
    all[PAID_ROUTES.ticker] = {
      accepts: {
        scheme: "exact",
        network,
        payTo,
        price: { amount: config.priceTickerZat, asset: ASSET_YEC, extra: { assetTransferMethod: "transparent" } },
        maxTimeoutSeconds: 300,
      },
      description: "One ticker line, a small transparent YEC payment served from the mempool",
      mimeType: "application/json",
    };
  }
  if (modes.channel) {
    all[PAID_ROUTES.channel] = {
      accepts: { scheme: "batch-settlement", network, payTo, price: { amount: config.priceChannelZat, asset: ASSET_YEC }, maxTimeoutSeconds: 300 },
      description: "One search, paid by a voucher on a YEC payment channel",
      mimeType: "application/json",
    };
  }
  if (modes.shielded && schemes.shieldedPayTo) {
    all[PAID_ROUTES.shielded] = {
      accepts: {
        scheme: "exact",
        network,
        payTo: schemes.shieldedPayTo,
        // The scheme adds the per-request memo and expiresAt (scheme_exact_ycash.md `sapling-proof`).
        price: { amount: config.priceShieldedZat, asset: ASSET_YEC, extra: { assetTransferMethod: "sapling-proof", paymentFlow: "upfront" } },
        maxTimeoutSeconds: SHIELDED_TIMEOUT_SECONDS,
      },
      description: "One report, paid privately in shielded YEC",
      mimeType: "application/json",
    };
  }
  const yed = config.yed;
  if (yed && modes.yedExact) {
    all[PAID_ROUTES.yedReport] = {
      // "$2.00": YED cents at par (the exact scheme's usdAsset), never below $1.00 (config.ts).
      accepts: { scheme: "exact", network, payTo: yed.payTo, price: yed.priceReport, maxTimeoutSeconds: 300 },
      description: "One report, paid per request in YED",
      mimeType: "application/json",
    };
  }
  if (yed && modes.yedChannel) {
    all[PAID_ROUTES.yedStream] = {
      accepts: { scheme: "batch-settlement", network, payTo: yed.payTo, price: yed.priceStream, maxTimeoutSeconds: 300 },
      description: "One stream chunk, paid by a voucher on a YED payment channel",
      mimeType: "application/json",
    };
  }
  return all;
}

/** An HTTP client for the configured facilitator (with its API key). */
export function facilitatorClientOf(config: MerchantConfig): FacilitatorClient {
  return new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    ...(config.facilitatorApiKey
      ? { createAuthHeaders: async () => ({ verify: { Authorization: `Bearer ${config.facilitatorApiKey}` }, settle: { Authorization: `Bearer ${config.facilitatorApiKey}` }, supported: { Authorization: `Bearer ${config.facilitatorApiKey}` } }) }
      : {}),
  });
}

const SHIELDED_TIMEOUT_SECONDS = 900;

export function createMerchant(config: MerchantConfig, opts: MerchantOptions = {}): Merchant {
  const facilitator = opts.facilitator ?? facilitatorClientOf(config);
  const server = new x402ResourceServer(facilitator);
  const schemes = (opts.register ?? registerServerSchemes)(server, {
    network: config.network,
    zeroConfCapZat: config.zeroConfCapZat,
    ...(config.wallet ? { wallet: config.wallet } : {}),
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.shielded ? { shielded: { ...config.shielded, amount: config.priceShieldedZat, maxTimeoutSeconds: SHIELDED_TIMEOUT_SECONDS } } : {}),
    ...(config.yed && opts.yed ? { yed: opts.yed } : {}),
    log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
  });
  const { modes } = schemes;

  const app = express();
  app.disable("x-powered-by");

  app.get("/", (_req, res) => {
    res.json({
      network: config.network,
      routes: Object.fromEntries((Object.keys(PAID_ROUTES) as PaidRoute[]).map((r) => [PAID_ROUTES[r], modes[MODE_OF[r]] ? "paid" : "not wired"])),
    });
  });

  const paid = routes(config, schemes);
  if (Object.keys(paid).length > 0) app.use(paymentMiddleware(paid, server));

  // Each paid route gets its handler only when the middleware guards it; otherwise a 501. Registering
  // the handler conditionally (rather than filtering paths by hand) leaves every path variant that
  // Express would match (case, trailing slash, HEAD) to Express itself.
  const handlers: Record<PaidRoute, express.RequestHandler> = {
    exact: (_req, res) => {
      res.json({ quote: "Fortune favours the prepared.", paidWith: "exact/transparent" });
    },
    ticker: (_req, res) => {
      res.json({ ticker: "YEC", note: "served on mempool acceptance", paidWith: "exact/transparent" });
    },
    channel: (req, res) => {
      res.json({ query: String(req.query.q ?? ""), results: ["ycash.xyz", "x402.org"], paidWith: "batch-settlement" });
    },
    shielded: (_req, res) => {
      res.json({ report: "Private report body.", paidWith: "exact/sapling-proof" });
    },
    yedReport: (_req, res) => {
      res.json({ report: "Dollar report body.", paidWith: "exact/transparent YED" });
    },
    yedStream: (req, res) => {
      res.json({ chunk: String(req.query.n ?? "0"), paidWith: "batch-settlement YED" });
    },
  };
  for (const name of Object.keys(PAID_ROUTES) as PaidRoute[]) {
    const route = PAID_ROUTES[name];
    const path = route.slice(route.indexOf(" ") + 1);
    app.get(
      path,
      route in paid
        ? handlers[name]
        : (_req, res) => {
            res.status(501).json({ error: "payment mode not configured", mode: MODE_OF[name] });
          },
    );
  }

  return { app, modes, close: async () => schemes.close?.() };
}
