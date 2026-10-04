// The agent: @x402/fetch wraps fetch so a 402 is answered by building a payment with the registered
// scheme and retrying with PAYMENT-SIGNATURE; the merchant's PAYMENT-RESPONSE carries the settlement.
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { ASSET_YED, exact } from "x402-ycash-mechanism";
import type { AgentConfig } from "./config.js";
import { registerClientSchemes, type ClientSchemes, type RegisterClientSchemes } from "./schemes.js";

export interface PaidResult {
  status: number;
  body: unknown;
  /** The decoded PAYMENT-RESPONSE header, when the merchant settled a payment. */
  settlement?: SettleResponse;
  /** On a 402 after paying: the reason the merchant gave (PAYMENT-REQUIRED `error`). */
  paymentError?: string;
  ms: number;
}

export interface Agent {
  schemes: string[];
  /** The channel client (status, close, refund), when batch-settlement is registered. */
  batch?: ClientSchemes["batch"];
  fetch: typeof fetch;
  call(url?: string): Promise<PaidResult>;
}

export function createAgent(config: AgentConfig, register: RegisterClientSchemes = registerClientSchemes, baseFetch: typeof fetch = fetch): Agent {
  const client = new x402Client();
  // YEC is not USD-pegged, so it is not a default asset: it is allowed explicitly with a cap in
  // zatoshis. Without this the client refuses every YEC 402. YED is a default asset with core's $1
  // cap (X-F43); its entry sets the agent's own cap in cents, so a $2 route is payable when allowed.
  client.setSpendControls({
    allowedAssets: [
      exact.yecSpendControl(config.network, BigInt(config.maxPaymentZat)),
      { network: config.network, asset: ASSET_YED, maxAmountPerPayment: config.maxPaymentYedCents ?? "100" },
    ],
  });
  const registered = register(client, {
    network: config.network,
    ...(config.node ? { node: config.node } : {}),
    ...(config.lwd ? { lwd: config.lwd } : {}),
    signer: config.signer,
    ...(config.shieldedFrom ? { shieldedFrom: config.shieldedFrom } : {}),
    ...(config.channelStorePath ? { channelStorePath: config.channelStorePath } : {}),
    ...(config.channelDepositZat !== undefined ? { channelDepositZat: config.channelDepositZat } : {}),
    ...(config.channelMaxDepositZat !== undefined ? { channelMaxDepositZat: config.channelMaxDepositZat } : {}),
    ...(config.channelMaxCloseFeeZat !== undefined ? { channelMaxCloseFeeZat: config.channelMaxCloseFeeZat } : {}),
    ...(config.reservationsPath ? { reservationsPath: config.reservationsPath } : {}),
    ...(config.yedChannelDepositCents !== undefined ? { yedChannelDepositCents: config.yedChannelDepositCents } : {}),
    ...(config.yedChannelMaxDepositCents !== undefined ? { yedChannelMaxDepositCents: config.yedChannelMaxDepositCents } : {}),
  });
  const paidFetch = wrapFetchWithPayment(baseFetch, client);

  return {
    schemes: registered.names,
    ...(registered.batch ? { batch: registered.batch } : {}),
    fetch: paidFetch,
    async call(url = config.url): Promise<PaidResult> {
      const t0 = performance.now();
      const res = await paidFetch(url, { method: "GET" });
      const header = res.headers.get("PAYMENT-RESPONSE");
      const required = res.status === 402 ? res.headers.get("PAYMENT-REQUIRED") : null;
      let paymentError: string | undefined;
      try {
        paymentError = required ? decodePaymentRequiredHeader(required).error : undefined;
      } catch {
        // an undecodable header: leave the reason out
      }
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: keep the text
      }
      return {
        status: res.status,
        body,
        ...(header ? { settlement: decodePaymentResponseHeader(header) } : {}),
        ...(paymentError ? { paymentError } : {}),
        ms: Math.round(performance.now() - t0),
      };
    },
  };
}
