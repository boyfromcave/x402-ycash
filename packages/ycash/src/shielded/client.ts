// The `sapling-proof` client: pays a requirement with the payer node's `z_sendmany` and presents the
// txid (spec, "sapling-proof", Client). A shielded source is tier P1 (nothing revealed on chain), a
// transparent `s…` source tier P0 (payer and amount visible, payee not).
import type { PaymentRequirements } from "@x402/core/types";
import { ASSET_YEC, YCASH_NETWORKS, type YcashNetwork } from "../constants.js";
import type { BlockchainInfo, NodeCapabilities, ZRecipient, ZSendManyOptions } from "../node/index.js";
import { ASSET_TRANSFER_METHOD_SAPLING_PROOF, CHAIN_OF, MEMO_REGEX, PAYMENT_FLOW_UPFRONT, SAPLING_HRP, SCHEME_EXACT } from "./constants.js";
import { memoToHex } from "./request.js";

export type PrivacyTier = "P0" | "P1";

/** The payer node calls the client makes. `YcashRpc` satisfies it. */
export interface ShieldedClientRpc {
  capabilities(): Promise<NodeCapabilities>;
  getBlockchainInfo(): Promise<BlockchainInfo>;
  zSendMany(from: string, recipients: ZRecipient[], opts?: ZSendManyOptions): Promise<string>;
  waitForOperation(opid: string, timeoutMs?: number, pollMs?: number): Promise<string>;
}

export interface ShieldedExactClientConfig {
  rpc: ShieldedClientRpc;
  /** The payer's source: a Sapling address (P1) or a transparent `s…` address (P0). */
  from: string;
  /** z_sendmany minconf for the source's notes or coins (default 1). */
  minconf?: number;
  /** zatoshis; omitted lets the node choose (both lines meet the per-Sapling-output floor, plan S-8). */
  fee?: bigint;
  /**
   * 6.21.0's z_sendmany privacy policy. Default: none for a shielded source (the node's
   * FullPrivacy), "AllowFullyTransparent" for a transparent one, whose change is transparent (X-F12).
   * Ignored on v4.5.0, which has no such argument.
   */
  privacyPolicy?: string;
  /** How long to wait for the z_sendmany operation, milliseconds (default 120 s). */
  timeoutMs?: number;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

/** The tier a source address gives, from its prefix. */
export function tierOf(from: string, network: YcashNetwork): PrivacyTier {
  if (from.startsWith(SAPLING_HRP[network] + "1")) return "P1";
  if (/^s[1-9A-HJ-NP-Za-km-z]{20,}$/.test(from)) return "P0";
  throw new Error(`${from} is neither a ${network} Sapling address nor a transparent address`);
}

export class ShieldedExactClient {
  readonly scheme = SCHEME_EXACT;
  private readonly config: ShieldedExactClientConfig;

  constructor(config: ShieldedExactClientConfig) {
    this.config = config;
  }

  /** Sends `amount` to `payTo` with the memo, waits for the txid, and returns the payload. */
  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<{ x402Version: number; payload: { txid: string } }> {
    const { tier } = await this.check(requirements);
    const caps = await this.config.rpc.capabilities();
    const opts: ZSendManyOptions = { minconf: this.config.minconf ?? 1 };
    if (this.config.fee !== undefined) opts.fee = this.config.fee;
    if (caps.line === "v6") {
      const policy = this.config.privacyPolicy ?? (tier === "P0" ? "AllowFullyTransparent" : undefined);
      if (policy) opts.privacyPolicy = policy;
    }
    const memo = requirements.extra.memo as string;
    const opid = await this.config.rpc.zSendMany(this.config.from, [{ address: requirements.payTo, amount: BigInt(requirements.amount), memo: memoToHex(memo) }], opts);
    const txid = await this.config.rpc.waitForOperation(opid, this.config.timeoutMs ?? 120_000);
    return { x402Version, payload: { txid } };
  }

  /** The requirement is one this client can pay, on the chain its node is on, before any money moves. */
  private async check(requirements: PaymentRequirements): Promise<{ network: YcashNetwork; tier: PrivacyTier }> {
    const network = requirements.network as YcashNetwork;
    if (!YCASH_NETWORKS.includes(network)) throw new Error(`not a Ycash network: ${requirements.network}`);
    if (requirements.scheme !== SCHEME_EXACT || requirements.asset !== ASSET_YEC) throw new Error("not an exact YEC requirement");
    const extra = requirements.extra ?? {};
    if (extra.assetTransferMethod !== ASSET_TRANSFER_METHOD_SAPLING_PROOF) throw new Error("not a sapling-proof requirement");
    if (extra.paymentFlow !== PAYMENT_FLOW_UPFRONT) throw new Error("sapling-proof requires paymentFlow upfront");
    if (typeof extra.memo !== "string" || !MEMO_REGEX.test(extra.memo)) throw new Error("extra.memo is missing or malformed");
    if (!/^[1-9]\d*$/.test(requirements.amount)) throw new Error(`bad amount ${requirements.amount}`);
    if (!requirements.payTo.startsWith(SAPLING_HRP[network] + "1")) throw new Error(`payTo is not a ${network} Sapling address`);
    const now = this.config.now ? this.config.now() : Math.floor(Date.now() / 1000);
    if (typeof extra.expiresAt !== "number" || extra.expiresAt <= now) throw new Error("the requirement has expired");
    const chain = (await this.config.rpc.getBlockchainInfo()).chain;
    if (chain !== CHAIN_OF[network]) throw new Error(`the payer node is on ${chain}, not ${network}`);
    return { network, tier: tierOf(this.config.from, network) };
  }
}
