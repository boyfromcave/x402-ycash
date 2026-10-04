// The merchant: one paid route per payment mode, behind @x402/express's paymentMiddleware, which
// answers 402 with PAYMENT-REQUIRED, reads PAYMENT-SIGNATURE, calls the facilitator's /verify and
// /settle, and returns PAYMENT-RESPONSE (specs/transports-v2/http.md).
import express from "express";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ASSET_YEC } from "x402-ycash-mechanism";
import type { MerchantConfig } from "./config.js";
import { registerServerSchemes, type PaymentModes, type RegisterServerSchemes, type ServerSchemes, type YedModes } from "./schemes.js";
import { facilitatorListsMethod, MethodGate } from "./shielded.js";
import { SupportedCache, YedGate } from "./yed.js";

export interface MerchantOptions {
  /** Defaults to an HTTPFacilitatorClient on `config.facilitatorUrl`. */
  facilitator?: FacilitatorClient;
  /** Defaults to schemes.ts; tests pass a fake. */
  register?: RegisterServerSchemes;
  /** The YED modes probeYed (yed.ts) found; absent (and no yedProbe), the YED routes answer 501. */
  yed?: YedModes;
  /**
   * Re-probes the YED modes (probeYed bound to the facilitator and node). With it the YED routes are
   * wired whenever YED is configured and gated live: re-probed every `yedReprobeMs` and when a
   * request reaches a YED route that is off, so YED comes on when the facilitator starts after the
   * merchant. `yed` is then the initial view.
   */
  yedProbe?: (facilitator: FacilitatorClient) => Promise<YedModes>;
  /** default 60 s */
  yedReprobeMs?: number;
  /**
   * Whether the facilitator lists `sapling` (the initial view; default: not until probed). The
   * sapling route is gated live on the facilitator's /supported, re-probed every `saplingReprobeMs`
   * (default 60 s) and when a request reaches it while off.
   */
  saplingListed?: boolean;
  saplingReprobeMs?: number;
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
  privateReport: "GET /shielded/private-report",
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
  privateReport: "sapling",
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
  if (modes.sapling && schemes.saplingPayTo) {
    all[PAID_ROUTES.privateReport] = {
      accepts: {
        scheme: "exact",
        network,
        payTo: schemes.saplingPayTo,
        // Authorization flow: the facilitator decrypts the client's unbroadcast transaction before
        // the handler runs and broadcasts it after (scheme_exact_ycash.md `sapling`).
        price: { amount: config.pricePrivateReportZat, asset: ASSET_YEC, extra: { assetTransferMethod: "sapling" } },
        maxTimeoutSeconds: SHIELDED_TIMEOUT_SECONDS,
      },
      description: "One private report, paid in shielded YEC and charged only when served",
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
  const raw = opts.facilitator ?? facilitatorClientOf(config);
  const probe = opts.yedProbe;
  const facilitator = config.yed && probe ? new SupportedCache(raw) : raw;
  const server = new x402ResourceServer(facilitator);
  const log = (msg: string, fields?: Record<string, unknown>): void => console.log(JSON.stringify({ msg, ...fields }));
  // A live YED gate: the schemes are wired for everything YED can do, and each request asks the gate.
  // On a change the resource server reloads the facilitator's kinds (its YED asset list).
  const gate = config.yed && probe && facilitator instanceof SupportedCache
    ? new YedGate(opts.yed ?? { exact: false, channel: false, maxDepositCents: config.yed.maxDepositCents }, () => probe(facilitator), {
      ...(opts.yedReprobeMs !== undefined ? { intervalMs: opts.yedReprobeMs } : {}),
      log,
      onChange: () => facilitator.reload(() => server.initialize()).catch((e: unknown) => log("facilitator reload failed", { error: String(e) })),
    })
    : undefined;
  const yedWiring: YedModes | undefined = config.yed && gate ? { exact: true, channel: true, maxDepositCents: config.yed.maxDepositCents } : opts.yed;
  const schemes = (opts.register ?? registerServerSchemes)(server, {
    network: config.network,
    zeroConfCapZat: config.zeroConfCapZat,
    ...(config.wallet ? { wallet: config.wallet } : {}),
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.shielded ? { shielded: { ...config.shielded, amount: config.priceShieldedZat, saplingAmount: config.pricePrivateReportZat, maxTimeoutSeconds: SHIELDED_TIMEOUT_SECONDS } } : {}),
    ...(config.yed && yedWiring ? { yed: yedWiring } : {}),
    log,
  });
  // What the schemes can serve; with a gate, the YED modes are that and the gate's current view.
  const wired = schemes.modes;
  // The sapling route is served only while the facilitator lists `sapling` (its viewing key is configured).
  const saplingGate = wired.sapling
    ? new MethodGate(opts.saplingListed ?? false, () => facilitatorListsMethod(raw, config.network, "sapling"), { log, what: "sapling", ...(opts.saplingReprobeMs !== undefined ? { intervalMs: opts.saplingReprobeMs } : {}) })
    : undefined;
  const modes: PaymentModes = Object.defineProperties({ ...wired }, {
    ...(gate
      ? {
        yedExact: { enumerable: true, get: () => wired.yedExact && gate.modes.exact },
        yedChannel: { enumerable: true, get: () => wired.yedChannel && gate.modes.channel },
      }
      : {}),
    ...(saplingGate ? { sapling: { enumerable: true, get: () => wired.sapling && saplingGate.listed } } : {}),
  });

  const app = express();
  app.disable("x-powered-by");

  app.get("/", (_req, res) => {
    res.json({
      network: config.network,
      routes: Object.fromEntries((Object.keys(PAID_ROUTES) as PaidRoute[]).map((r) => [PAID_ROUTES[r], modes[MODE_OF[r]] ? "paid" : "not wired"])),
    });
  });

  const paid = routes(config, schemes);
  // While the gate has YED off, a YED route re-probes once (rate-limited) and answers 501 if still off.
  if (gate) {
    for (const name of ["yedReport", "yedStream"] as const) {
      const route = PAID_ROUTES[name];
      if (!(route in paid)) continue;
      app.get(route.slice(route.indexOf(" ") + 1), (_req, res, next) => {
        void (async () => {
          if (!modes[MODE_OF[name]]) await gate.refresh();
          if (modes[MODE_OF[name]]) return next();
          res.status(501).json({ error: "payment mode not available", mode: MODE_OF[name], reason: "the facilitator does not list YED, or the node does not run -yellowback (re-probed)" });
        })().catch(next);
      });
    }
    gate.start();
  }
  if (saplingGate && PAID_ROUTES.privateReport in paid) {
    const route = PAID_ROUTES.privateReport;
    app.get(route.slice(route.indexOf(" ") + 1), (_req, res, next) => {
      void (async () => {
        if (!modes.sapling) await saplingGate.refresh();
        if (modes.sapling) return next();
        res.status(501).json({ error: "payment mode not available", mode: "sapling", reason: "the facilitator does not list sapling (it needs the merchant's viewing key; re-probed)" });
      })().catch(next);
    });
    if (opts.saplingListed === undefined) void saplingGate.refresh(true);
    saplingGate.start();
  }
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
    privateReport: (_req, res) => {
      res.json({ report: "Private report body, charged only once served.", paidWith: "exact/sapling" });
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

  return {
    app,
    modes,
    close: async () => {
      gate?.stop();
      saplingGate?.stop();
      await schemes.close?.();
    },
  };
}
