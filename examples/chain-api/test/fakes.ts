// Copyright (c) 2026 The Ycash developers. MIT License.
//
// Test doubles: a node answering the read RPCs from canned data, and a fake `exact` client and
// facilitator scheme (the real Ycash server scheme runs in the API). The fake facilitator refuses
// a transaction it has settled before, as the real one's settlement store does.
import type { Network, PaymentPayload, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import { RpcError } from "x402-ycash-mechanism";
import type { RpcCaller } from "../src/reader.js";

export const TXID = "ab".repeat(32);
export const PREV = "cd".repeat(32);
export const BLOCK = "00".repeat(31) + "0f";

/** A node: every call is recorded; `answers` maps a method to a value or a function of the params. */
export class FakeNode implements RpcCaller {
  readonly calls: { method: string; params: readonly unknown[] }[] = [];
  readonly answers: Record<string, unknown> = {
    getblockcount: 120,
    getblockchaininfo: {
      chain: "regtest",
      blocks: 120,
      headers: 120,
      bestblockhash: BLOCK,
      difficulty: 1,
      valuePools: [{ id: "transparent", chainValueZat: 1 }],
      transparentPools: [{ id: "transparent_ecc", chainValueZat: 1 }],
      upgrades: { "6d5b7a31": { name: "Vault", activationheight: 200, status: "pending" } },
    },
    getnetworksolps: 3,
    getmempoolinfo: { size: 2, bytes: 500 },
    getnetworkinfo: { relayfee: 0.000001, subversion: "/YcashCpp:6.22.0/" },
    getrawmempool: { [TXID]: { fee: 0.0001, size: 250 }, [PREV]: { fee: 0.00002, size: 200 } },
    getblockhash: BLOCK,
    getblock: { hash: BLOCK, height: 120, confirmations: 1, tx: [TXID], valuePools: [], blockfee: 0, solution: "ff".repeat(1000) },
    getrawtransaction: (params: readonly unknown[]) => {
      if (params[0] === PREV) return { txid: PREV, version: 4, locktime: 0, vin: [{ coinbase: "00" }], vout: [{ n: 0, value: 1, valueZat: 100_000_000 }] };
      if (params[0] === TXID) {
        return {
          txid: TXID,
          version: 4,
          overwintered: true,
          locktime: 0,
          expiryheight: 140,
          vin: [{ txid: PREV, vout: 0 }],
          vout: [{ n: 0, value: 0.9999, valueZat: 99_990_000, scriptPubKey: { type: "pubkeyhash", addresses: ["tmX"] } }],
          valueBalanceZat: 0,
          blockhash: BLOCK,
          height: 120,
          confirmations: 1,
        };
      }
      throw new RpcError(-5, "No information available about transaction", "getrawtransaction");
    },
    getaddressbalance: { balance: 5, received: 7 },
    getaddressutxos: [{ txid: TXID, outputIndex: 0, satoshis: 5, height: 100 }],
    getaddresstxids: [PREV, TXID],
    getaddressmempool: [],
    sendrawtransaction: TXID,
  };

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    if (!(method in this.answers)) throw new RpcError(-32601, "Method not found", method);
    const a = this.answers[method];
    if (a instanceof Error) throw a;
    return (typeof a === "function" ? (a as (p: readonly unknown[]) => unknown)(params) : a) as T;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

/** The fake client: a fresh "transaction" per payment, or `replay` to resend the last one, or tampering. */
export class FakeClient implements SchemeNetworkClient {
  readonly scheme = "exact";
  n = 0;
  last = "";
  /** Distinct per client, so two clients never sign the same "transaction". */
  readonly id = Math.random().toString(36).slice(2);
  replay = false;
  async createPaymentPayload(x402Version: number, _req: PaymentRequirements): Promise<PaymentPayloadResult> {
    if (!this.replay) this.last = `tx-${this.id}-${++this.n}`;
    return { x402Version, payload: { transaction: this.last } };
  }
}

export class FakeFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "ycash:*";
  readonly calls: string[] = [];
  private readonly settled = new Set<string>();
  getExtra(_network: Network): Record<string, unknown> {
    return { assets: ["YEC"], assetTransferMethods: ["transparent"], areFeesSponsored: false, confirmations: { minimum: -1, maximum: 20 } };
  }
  getSigners(_network: string): string[] {
    return [];
  }
  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    this.calls.push("verify");
    const t = String(p.payload.transaction);
    if (this.settled.has(t)) return { isValid: false, invalidReason: "invalid_exact_ycash_replay" };
    if (p.accepted.amount !== req.amount || p.accepted.payTo !== req.payTo || p.accepted.network !== req.network) return { isValid: false, invalidReason: "invalid_exact_ycash_amount" };
    return { isValid: true, payer: "tmAgent" };
  }
  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.calls.push("settle");
    const t = String(p.payload.transaction);
    if (this.settled.has(t)) return { success: false, errorReason: "invalid_exact_ycash_replay", transaction: "", network: req.network };
    this.settled.add(t);
    return { success: true, transaction: "ef".repeat(32), network: req.network, payer: "tmAgent", amount: req.amount };
  }
}
