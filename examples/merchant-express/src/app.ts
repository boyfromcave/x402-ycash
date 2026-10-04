// The merchant: one paid route per payment mode, behind @x402/express's paymentMiddleware, which
// answers 402 with PAYMENT-REQUIRED, reads PAYMENT-SIGNATURE, calls the facilitator's /verify and
// /settle, and returns PAYMENT-RESPONSE (specs/transports-v2/http.md).
import express from "express";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ASSET_YEC, type YcashRpc } from "x402-ycash-mechanism";
import type { MerchantConfig } from "./config.js";
import { registerServerSchemes, type PaymentModes, type RegisterServerSchemes } from "./schemes.js";

export interface MerchantOptions {
  /** Defaults to an HTTPFacilitatorClient on `config.facilitatorUrl`. */
  facilitator?: FacilitatorClient;
  /** Defaults to schemes.ts; tests pass a fake. */
  register?: RegisterServerSchemes;
}

export interface Merchant {
  app: express.Express;
  modes: PaymentModes;
}

/** The paid routes, keyed as paymentMiddleware wants them ("VERB /path"). */
export const PAID_ROUTES = {
  exact: "GET /exact/quote",
  channel: "GET /channel/search",
  shielded: "GET /shielded/report",
} as const satisfies Record<keyof PaymentModes, string>;

/** A fresh diversified Sapling address per request, from one base address (X-F11). */
function shieldedPayTo(wallet: YcashRpc): () => Promise<string> {
  let base: Promise<string> | undefined;
  return async () => {
    base ??= wallet.zGetNewAddress();
    return wallet.zGetNewDiversifiedAddress(await base);
  };
}

function routes(config: MerchantConfig, modes: PaymentModes): RoutesConfig {
  const { network, payTo } = config;
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
  }
  if (modes.channel) {
    all[PAID_ROUTES.channel] = {
      accepts: { scheme: "batch-settlement", network, payTo, price: { amount: config.priceChannelZat, asset: ASSET_YEC }, maxTimeoutSeconds: 300 },
      description: "One search, paid by a voucher on a YEC payment channel",
      mimeType: "application/json",
    };
  }
  if (modes.shielded && config.wallet) {
    all[PAID_ROUTES.shielded] = {
      accepts: {
        scheme: "exact",
        network,
        payTo: shieldedPayTo(config.wallet),
        // The scheme adds the per-request memo and expiresAt (scheme_exact_ycash.md `sapling-proof`).
        price: { amount: config.priceShieldedZat, asset: ASSET_YEC, extra: { assetTransferMethod: "sapling-proof", paymentFlow: "upfront" } },
        maxTimeoutSeconds: 900,
      },
      description: "One report, paid privately in shielded YEC",
      mimeType: "application/json",
    };
  }
  return all;
}

export function createMerchant(config: MerchantConfig, opts: MerchantOptions = {}): Merchant {
  const facilitator =
    opts.facilitator ??
    new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
      ...(config.facilitatorApiKey
        ? { createAuthHeaders: async () => ({ verify: { Authorization: `Bearer ${config.facilitatorApiKey}` }, settle: { Authorization: `Bearer ${config.facilitatorApiKey}` } }) }
        : {}),
    });
  const server = new x402ResourceServer(facilitator);
  const modes = (opts.register ?? registerServerSchemes)(server, { network: config.network, ...(config.wallet ? { wallet: config.wallet } : {}) });

  const app = express();
  app.disable("x-powered-by");

  app.get("/", (_req, res) => {
    res.json({
      network: config.network,
      routes: Object.fromEntries(Object.entries(PAID_ROUTES).map(([mode, route]) => [route, modes[mode as keyof PaymentModes] ? "paid" : "not wired"])),
    });
  });

  const paid = routes(config, modes);
  if (Object.keys(paid).length > 0) app.use(paymentMiddleware(paid, server));

  // Each paid route gets its handler only when the middleware guards it; otherwise a 501. Registering
  // the handler conditionally (rather than filtering paths by hand) leaves every path variant that
  // Express would match (case, trailing slash, HEAD) to Express itself.
  const handlers: Record<keyof PaymentModes, express.RequestHandler> = {
    exact: (_req, res) => {
      res.json({ quote: "Fortune favours the prepared.", paidWith: "exact/transparent" });
    },
    channel: (req, res) => {
      res.json({ query: String(req.query.q ?? ""), results: ["ycash.xyz", "x402.org"], paidWith: "batch-settlement" });
    },
    shielded: (_req, res) => {
      res.json({ report: "Private report body.", paidWith: "exact/sapling-proof" });
    },
  };
  for (const mode of Object.keys(PAID_ROUTES) as (keyof PaymentModes)[]) {
    const route = PAID_ROUTES[mode];
    const path = route.slice(route.indexOf(" ") + 1);
    app.get(
      path,
      route in paid
        ? handlers[mode]
        : (_req, res) => {
            res.status(501).json({ error: "payment mode not wired yet", mode });
          },
    );
  }

  return { app, modes };
}
