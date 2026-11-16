// Copyright (c) 2026 The Ycash developers. MIT License.
//
// The routes the API sells, with their prices and parameter rules: one table read by the payment
// middleware, the Express router and /pricing, so the three cannot disagree.
import { tx, type YcashNetwork } from "x402-ycash-mechanism";
import type { ChainApiConfig } from "./config.js";

export type RouteId = "tx" | "address" | "block" | "chain" | "yellowback" | "broadcast";

export interface PaidRoute {
  id: RouteId;
  method: "GET" | "POST";
  /** Express path (and the x402 route pattern): `:name` parameters. */
  path: string;
  description: string;
  /** For /pricing: what each parameter is. */
  params: Record<string, string>;
  /** An example request path an agent can try. */
  example: string;
}

export const ROUTES: readonly PaidRoute[] = [
  {
    id: "tx",
    method: "GET",
    path: "/v1/tx/:txid",
    description: "A transaction, decoded: inputs, outputs by type, Sapling and Sprout counts, confirmations and fee",
    params: { txid: "64 hexadecimal characters" },
    example: "/v1/tx/<txid>",
  },
  {
    id: "address",
    method: "GET",
    path: "/v1/address/:address",
    description: "A transparent address: balance, received, unspent outputs, recent history and mempool activity (the node's address index)",
    params: { address: "a transparent address of this network (P2PKH, P2SH, post-quantum or Yellowback)" },
    example: "/v1/address/<address>",
  },
  {
    id: "block",
    method: "GET",
    path: "/v1/block/:id",
    description: "A block by height or hash: header, transaction ids, chain value pools and transparent pools by type",
    params: { id: "a height (decimal) or a block hash (64 hexadecimal characters)" },
    example: "/v1/block/1",
  },
  {
    id: "chain",
    method: "GET",
    path: "/v1/chain",
    description: "The chain now: tip, difficulty, network solution rate, upgrades, value pools, mempool size and fee rates",
    params: {},
    example: "/v1/chain",
  },
  {
    id: "yellowback",
    method: "GET",
    path: "/v1/yellowback",
    description: "Yellowback where the network has it: the vault upgrade's status, the vault primitive's state and the YED module's reads",
    params: {},
    example: "/v1/yellowback",
  },
  {
    id: "broadcast",
    method: "POST",
    path: "/v1/broadcast",
    description: "Relays a signed raw transaction to the network (paid relay); answers its txid, or 422 with the node's reason (not charged)",
    params: { body: 'JSON {"hex": "<signed transaction>"}, at most 100,000 bytes of transaction' },
    example: "/v1/broadcast",
  },
];

/** The largest transaction the relay accepts, bytes (the node's standard-size limit). */
export const MAX_TX_BYTES = 100_000;

/** The x402 pattern of a route ("GET /v1/tx/:txid"). */
export const patternOf = (r: PaidRoute): string => `${r.method} ${r.path}`;

/** The price of a route, zatoshis. */
export const priceOf = (r: PaidRoute, c: Pick<ChainApiConfig, "priceZat" | "priceBroadcastZat">): bigint => (r.id === "broadcast" ? c.priceBroadcastZat : c.priceZat);

/** Zatoshis as a YEC decimal string ("0.0001"). */
export function yecOf(z: bigint): string {
  const whole = z / 100_000_000n;
  const frac = (z % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Checks a route's parameters before any payment or node work: a bad request is answered 400 and
 * never charged.
 *
 * @param id - The route.
 * @param params - Express's path parameters.
 * @param network - The network addresses must belong to.
 * @returns undefined when valid, else the reason.
 */
export function invalidParams(id: RouteId, params: Record<string, string | undefined>, network: YcashNetwork): string | undefined {
  switch (id) {
    case "tx":
      return HEX64.test(params.txid ?? "") ? undefined : "txid must be 64 hexadecimal characters";
    case "block": {
      const v = params.id ?? "";
      if (HEX64.test(v)) return undefined;
      return /^\d{1,9}$/.test(v) ? undefined : "id must be a height (at most 9 digits) or a 64-hex block hash";
    }
    case "address": {
      const a = params.address ?? "";
      if (a.length > 128 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return "address must be a base58 transparent address";
      try {
        tx.decodeAddress(a, network);
      } catch (e) {
        return `address: ${(e as Error).message}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Checks the relay's body: one even-length hex string, at most MAX_TX_BYTES bytes, no other key.
 *
 * @param body - The parsed JSON body.
 * @returns The hex, lower-cased, or the reason it is refused.
 */
export function broadcastHexOf(body: unknown): { hex: string } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: 'the body must be JSON {"hex": "<signed transaction>"}' };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "hex") return { error: 'the body must have exactly one key, "hex"' };
  const hex = (body as { hex: unknown }).hex;
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return { error: "hex must be an even-length hexadecimal string" };
  if (hex.length / 2 > MAX_TX_BYTES) return { error: `the transaction must be at most ${MAX_TX_BYTES} bytes` };
  return { hex: hex.toLowerCase() };
}
