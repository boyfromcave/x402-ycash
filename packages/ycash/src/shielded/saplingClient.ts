// The `sapling` client (spec, "sapling", Client): checks the requirement, asks a Sapling builder for a
// signed transaction paying payTo with the memo, checks the answer's shape, and hands the hex over
// unbroadcast. The facilitator broadcasts it after the resource ran (authorization flow).
import type { PaymentRequirements } from "@x402/core/types";
import { ASSET_YEC, YCASH_NETWORKS, type YcashNetwork } from "../constants.js";
import { clientExpiryHeight } from "../exact/policy.js";
import { parseTx, txid as txidOf } from "../tx/index.js";
import type { SaplingTransactionBuilder } from "./builder.js";
import { ASSET_TRANSFER_METHOD_SAPLING, MEMO_REGEX, SAPLING_HRP, SCHEME_EXACT } from "./constants.js";
import { memoToHex } from "./request.js";
import { PAYMENT_FLOW_AUTHORIZATION } from "./saplingFacilitator.js";

export interface SaplingExactClientConfig {
  builder: SaplingTransactionBuilder;
  /** The tip, when the client can read it: then it sets nExpiryHeight itself (spec: tip + 3 + ⌈t/75⌉). */
  chain?: { getBlockCount(): Promise<number> };
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

/** Pays `exact` YEC `sapling` requirements with a transaction from the configured builder. */
export class SaplingExactClient {
  readonly scheme = SCHEME_EXACT;

  /**
   * Keeps the builder.
   *
   * @param config - The builder and, optionally, a chain view for the expiry height.
   */
  constructor(private readonly config: SaplingExactClientConfig) {}

  /**
   * Builds the payload: `{transaction}` with the builder's signed hex.
   *
   * @param x402Version - The protocol version, echoed into the payload.
   * @param requirements - The `sapling` requirement.
   * @returns The payload.
   * @throws Error when the requirement is not payable, or the builder fails or answers a wrong shape.
   */
  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<{ x402Version: number; payload: { transaction: string } }> {
    this.check(requirements);
    const expiryHeight = this.config.chain ? clientExpiryHeight(await this.config.chain.getBlockCount(), requirements.maxTimeoutSeconds) : undefined;
    const built = await this.config.builder.build({
      to: requirements.payTo,
      amountZat: requirements.amount,
      memoHex: memoToHex(requirements.extra.memo as string),
      ...(expiryHeight !== undefined ? { expiryHeight } : {}),
    });
    let tx;
    try {
      tx = parseTx(built.txHex);
    } catch (e) {
      throw new Error(`the builder's transaction does not decode: ${(e as Error).message}`);
    }
    if (txidOf(tx) !== built.txid) throw new Error(`the builder's txid ${built.txid} is not the transaction's`);
    if (tx.shieldedOutputs.length === 0 || tx.joinSplits.length > 0 || tx.lockTime !== 0) throw new Error("the builder's transaction is not a Sapling payment of the required shape");
    if (expiryHeight !== undefined && tx.expiryHeight !== expiryHeight) throw new Error(`the builder set nExpiryHeight ${tx.expiryHeight}, not ${expiryHeight}`);
    return { x402Version, payload: { transaction: built.txHex } };
  }

  /**
   * Every check that needs no builder: an unexpired exact YEC `sapling` requirement with a memo and
   * a Sapling payTo of its network.
   *
   * @param requirements - The requirement.
   * @throws Error naming the first failed check.
   */
  private check(requirements: PaymentRequirements): void {
    const network = requirements.network as YcashNetwork;
    if (!YCASH_NETWORKS.includes(network)) throw new Error(`not a Ycash network: ${requirements.network}`);
    if (requirements.scheme !== SCHEME_EXACT || requirements.asset !== ASSET_YEC) throw new Error("not an exact YEC requirement");
    const extra = requirements.extra ?? {};
    if (extra.assetTransferMethod !== ASSET_TRANSFER_METHOD_SAPLING) throw new Error("not a sapling requirement");
    if (extra.paymentFlow !== undefined && extra.paymentFlow !== PAYMENT_FLOW_AUTHORIZATION) throw new Error("sapling is an authorization-flow method");
    if (typeof extra.memo !== "string" || !MEMO_REGEX.test(extra.memo)) throw new Error("extra.memo is missing or malformed");
    if (!/^[1-9]\d*$/.test(requirements.amount)) throw new Error(`bad amount ${requirements.amount}`);
    if (!requirements.payTo.startsWith(SAPLING_HRP[network] + "1")) throw new Error(`payTo is not a ${network} Sapling address`);
    const now = this.config.now ? this.config.now() : Math.floor(Date.now() / 1000);
    if (typeof extra.expiresAt !== "number" || extra.expiresAt <= now) throw new Error("the requirement has expired");
  }
}
