// The facilitator's HTTP surface (spec §7): POST /verify, POST /settle, GET /supported, plus
// GET /healthz. Generic over the schemes registered on the x402Facilitator it is given.
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { x402Facilitator } from "@x402/core/facilitator";
import type { Network, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { YcashNetwork } from "x402-ycash-mechanism";
import type { ConfirmationLimits } from "./config.js";
import type { Logger } from "./logger.js";
import { CHAIN_OF_NETWORK, type NodeProbe } from "./node.js";
import { ERR_INVALID_PAYLOAD, ERR_UNEXPECTED_SETTLE, ERR_UNEXPECTED_VERIFY, validateRequest } from "./validation.js";

/** Spec §7.2.1: extension outcomes travel in this header, never in the body. */
export const EXTENSION_RESPONSES_HEADER = "EXTENSION-RESPONSES";

/** The abort prefix x402Facilitator.settle puts on a before-settle hook's reason. */
const SETTLE_ABORT_PREFIX = "Settlement aborted: ";

export interface AppOptions {
  facilitator: x402Facilitator;
  network: YcashNetwork;
  node: NodeProbe;
  confirmations: ConfirmationLimits;
  logger: Logger;
  bodyLimit?: string;
  apiKey?: string;
}

export interface FacilitatorApp {
  app: express.Express;
  /** Requests currently being handled; shutdown waits for these (a settle may be mid-broadcast). */
  inFlight(): number;
  /** After this, /healthz answers 503 and new /verify and /settle get 503. */
  beginShutdown(): void;
}

type SupportedKind = ReturnType<x402Facilitator["getSupported"]>["kinds"][number];

/**
 * `/supported` with the operator's confirmation range on every Ycash kind whose mechanism did not
 * advertise one itself (scheme_exact_ycash.md `/supported`: `extra.confirmations`).
 */
export function withConfirmationLimits(kinds: SupportedKind[], limits: ConfirmationLimits): SupportedKind[] {
  return kinds.map(k =>
    k.network.startsWith("ycash:") && k.extra?.confirmations === undefined
      ? { ...k, extra: { ...k.extra, confirmations: { ...limits } } }
      : k,
  );
}

/** Moves `extensionResponses` out of the body into the base64 JSON header (spec §7.2.1). */
function sendWithSidechannel(res: Response, status: number, result: VerifyResponse | SettleResponse): void {
  const { extensionResponses, ...body } = result;
  if (extensionResponses && Object.keys(extensionResponses).length > 0) {
    res.setHeader(EXTENSION_RESPONSES_HEADER, Buffer.from(JSON.stringify(extensionResponses), "utf8").toString("base64"));
  }
  res.status(status).json(body);
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function createApp(opts: AppOptions): FacilitatorApp {
  const { facilitator, network, node, confirmations, logger } = opts;
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  let inFlight = 0;
  let shuttingDown = false;
  const expectedKey = opts.apiKey ? digest(opts.apiKey) : undefined;

  // Request id, timing and one structured line per request.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    const id = randomUUID();
    res.locals.log = logger.child({ reqId: id });
    res.setHeader("X-Request-Id", id);
    inFlight++;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      inFlight--;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      (res.locals.log as Logger).info("request", { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms * 10) / 10, ...(res.locals.outcome ?? {}) });
    };
    res.on("finish", finish);
    res.on("close", finish);
    next();
  });

  const guard = (kind: "verify" | "settle") => (req: Request, res: Response, next: NextFunction): void => {
    if (shuttingDown) {
      res.setHeader("Connection", "close");
      res.status(503).json(kind === "verify" ? { isValid: false, invalidReason: ERR_UNEXPECTED_VERIFY, invalidMessage: "shutting down" } : { success: false, errorReason: ERR_UNEXPECTED_SETTLE, errorMessage: "shutting down", transaction: "", network });
      return;
    }
    if (expectedKey) {
      const header = req.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!timingSafeEqual(digest(token), expectedKey)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Content-Type must be application/json" });
      return;
    }
    next();
  };

  const json = express.json({ limit: opts.bodyLimit ?? "512kb", strict: true });

  app.post("/verify", guard("verify"), json, async (req, res) => {
    const log = res.locals.log as Logger;
    const v = validateRequest(req.body, facilitator.getSupported().kinds);
    if (!v.ok) {
      res.locals.outcome = { op: "verify", reason: v.reason };
      sendWithSidechannel(res, v.status, { isValid: false, invalidReason: v.reason, invalidMessage: v.message });
      return;
    }
    const { paymentPayload, paymentRequirements } = v.request;
    try {
      const result = await facilitator.verify(paymentPayload, paymentRequirements);
      res.locals.outcome = { op: "verify", scheme: paymentRequirements.scheme, network: paymentRequirements.network, isValid: result.isValid, reason: result.invalidReason, payer: result.payer };
      sendWithSidechannel(res, 200, result);
    } catch (e) {
      // A mechanism threw: log it here, answer with the spec code only (no internals to the caller).
      log.error("verify failed", { scheme: paymentRequirements.scheme, network: paymentRequirements.network, error: e });
      res.locals.outcome = { op: "verify", reason: ERR_UNEXPECTED_VERIFY };
      sendWithSidechannel(res, 500, { isValid: false, invalidReason: ERR_UNEXPECTED_VERIFY });
    }
  });

  app.post("/settle", guard("settle"), json, async (req, res) => {
    const log = res.locals.log as Logger;
    const v = validateRequest(req.body, facilitator.getSupported().kinds);
    if (!v.ok) {
      res.locals.outcome = { op: "settle", reason: v.reason };
      sendWithSidechannel(res, v.status, { success: false, errorReason: v.reason, errorMessage: v.message, transaction: "", network: (v.network ?? network) as Network });
      return;
    }
    const { paymentPayload, paymentRequirements } = v.request;
    try {
      const result = await facilitator.settle(paymentPayload, paymentRequirements);
      res.locals.outcome = { op: "settle", scheme: paymentRequirements.scheme, network: paymentRequirements.network, success: result.success, reason: result.errorReason, transaction: result.transaction, payer: result.payer };
      sendWithSidechannel(res, 200, result);
    } catch (e) {
      // A before-settle hook's abort is a business outcome, not a fault (upstream e2e facilitator).
      if (e instanceof Error && e.message.startsWith(SETTLE_ABORT_PREFIX)) {
        const reason = e.message.slice(SETTLE_ABORT_PREFIX.length);
        res.locals.outcome = { op: "settle", reason };
        sendWithSidechannel(res, 200, { success: false, errorReason: reason, transaction: "", network: paymentRequirements.network });
        return;
      }
      log.error("settle failed", { scheme: paymentRequirements.scheme, network: paymentRequirements.network, error: e });
      res.locals.outcome = { op: "settle", reason: ERR_UNEXPECTED_SETTLE };
      sendWithSidechannel(res, 500, { success: false, errorReason: ERR_UNEXPECTED_SETTLE, transaction: "", network: paymentRequirements.network });
    }
  });

  app.get("/supported", (_req, res) => {
    const supported = facilitator.getSupported();
    // Core lists a family even when its mechanisms sign nothing; Ycash facilitators sign nothing, and
    // the spec's `/supported` shows `"signers": {}` (scheme_exact_ycash.md).
    const signers = Object.fromEntries(Object.entries(supported.signers).filter(([, list]) => list.length > 0));
    res.json({ kinds: withConfirmationLimits(supported.kinds, confirmations), extensions: supported.extensions, signers });
  });

  app.get("/healthz", async (_req, res) => {
    if (shuttingDown) {
      res.status(503).json({ status: "shutting_down", network });
      return;
    }
    try {
      const [caps, height] = await Promise.all([node.capabilities(), node.getBlockCount()]);
      const chainOk = caps.chain === CHAIN_OF_NETWORK[network];
      res.status(chainOk ? 200 : 503).json({
        status: chainOk ? "ok" : "chain_mismatch",
        network,
        node: { line: caps.line, chain: caps.chain, subversion: caps.subversion, yellowback: caps.yellowback, height },
        kinds: facilitator.getSupported().kinds.map(k => `${k.scheme}@${k.network}`),
      });
    } catch (e) {
      (res.locals.log as Logger).warn("healthz: node unreachable", { error: e });
      res.status(503).json({ status: "node_unreachable", network });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Body-parser errors (bad JSON, too large) and anything else: a fixed message, never the stack.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    const log = (res.locals.log as Logger | undefined) ?? logger;
    if (status >= 500) log.error("unhandled error", { path: req.path, error: err });
    if (res.headersSent) return;
    const isSettle = req.path === "/settle";
    const reason = status >= 500 ? (isSettle ? ERR_UNEXPECTED_SETTLE : ERR_UNEXPECTED_VERIFY) : ERR_INVALID_PAYLOAD;
    const message = status === 413 ? "request body too large" : status >= 500 ? undefined : "malformed JSON body";
    res.locals.outcome = { reason };
    if (req.path === "/verify" || isSettle) {
      res.status(status).json(isSettle ? { success: false, errorReason: reason, ...(message ? { errorMessage: message } : {}), transaction: "", network } : { isValid: false, invalidReason: reason, ...(message ? { invalidMessage: message } : {}) });
    } else {
      res.status(status).json({ error: status >= 500 ? "internal error" : (message ?? "bad request") });
    }
  });

  return {
    app,
    inFlight: () => inFlight,
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}
