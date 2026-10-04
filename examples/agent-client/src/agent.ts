// The agent: @x402/fetch wraps fetch so a 402 is answered by building a payment with the registered
// scheme and retrying with PAYMENT-SIGNATURE; the merchant's PAYMENT-RESPONSE carries the settlement.
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { SettleResponse } from "@x402/core/types";
import type { AgentConfig } from "./config.js";
import { registerClientSchemes, type RegisterClientSchemes } from "./schemes.js";

export interface PaidResult {
  status: number;
  body: unknown;
  /** The decoded PAYMENT-RESPONSE header, when the merchant settled a payment. */
  settlement?: SettleResponse;
  ms: number;
}

export interface Agent {
  schemes: string[];
  fetch: typeof fetch;
  call(url?: string): Promise<PaidResult>;
}

export function createAgent(config: AgentConfig, register: RegisterClientSchemes = registerClientSchemes, baseFetch: typeof fetch = fetch): Agent {
  const client = new x402Client();
  // YEC is not one of the SDK's default assets, so it must be allowed explicitly, with a cap in
  // zatoshis; without this the client refuses every Ycash 402.
  client.setSpendControls({ allowedAssets: [{ network: config.network, asset: "YEC", maxAmountPerPayment: config.maxPaymentZat }] });
  const schemes = register(client, { network: config.network, signer: config.signer });
  const paidFetch = wrapFetchWithPayment(baseFetch, client);

  return {
    schemes,
    fetch: paidFetch,
    async call(url = config.url): Promise<PaidResult> {
      const t0 = performance.now();
      const res = await paidFetch(url, { method: "GET" });
      const header = res.headers.get("PAYMENT-RESPONSE");
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
        ms: Math.round(performance.now() - t0),
      };
    },
  };
}
