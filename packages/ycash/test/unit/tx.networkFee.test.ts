// The network fee of PQ and Yellowback transactions (rpcversion 8, the fee structure): the node's
// yed_getinfo.params.fees.network rates, the YED client paying them by size, the facilitator's cap and
// allowhighfees, the channel close fee and relay. Fixture: ycash-dd q/fees (6cb0ac5db)
// doc/yellowback-rpc-contract.json, yed_getinfo.params.fees.network.
import { beforeEach, describe, expect, it } from "vitest";
import { exact } from "../../src/index.js";
import { InMemorySettlementStore } from "../../src/store/index.js";
import { classifySendError, RpcError, SendRawTransactionError } from "../../src/node/index.js";
import { sendChannelTransaction } from "../../src/batch/relay.js";
import { yedCloseNetworkFee } from "../../src/channel/outputs.js";
import {
  encodeAddress,
  feeFloor,
  hash160,
  needsHighFees,
  networkFee,
  networkFeeCap,
  networkFeesOf,
  newTx,
  parseTx,
  pubkeyFromPriv,
  serializeTx,
  sizeFee,
  SEQUENCE_FINAL,
  txFee,
  type NetworkFees,
} from "../../src/tx/index.js";
import { FakeNode, FakeUtxoSource, NETWORK, paymentPayload, requirements, testKey } from "./exact/fakeNode.js";

/** The contract's example (at $0.40/YEC: plain 5,000,000, Yellowback 12,500,000 zat/KB). */
const NETWORK_FEES = {
  priceMicroUsd: 400000,
  priceSource: "tip",
  plain: { usdPerKBMicro: 20000, zatPerKB: 5000000 },
  yellowback: { usdPerKBMicro: 50000, zatPerKB: 12500000, maxTxFeeUsdMicro: 2000000, maxTxFeeCeilingZat: 1000000000, maxTxFeeZat: 1000000000 },
  floorZatPerKB: 5000,
  fallbackZatPerKB: 100,
  flatZat: 1000,
  maxTxFeeZat: 10000000,
};
const info8 = { rpcversion: 8, params: { fees: { network: NETWORK_FEES } } };
const fees = networkFeesOf(info8) as NetworkFees;

const draft = (scriptSigBytes: number) =>
  newTx({ vin: [{ prevout: { txid: "00".repeat(32), vout: 0 }, scriptSig: new Uint8Array(scriptSigBytes), sequence: SEQUENCE_FINAL }], vout: [{ value: 1n, scriptPubKey: new Uint8Array(25) }] });

describe("networkFeesOf", () => {
  it("reads rpcversion 8's params.fees.network, in zatoshis", () => {
    expect(fees).toEqual({
      priceMicroUsd: 400000, priceSource: "tip", plainZatPerKB: 5_000_000n, yellowbackZatPerKB: 12_500_000n,
      flatZat: 1000n, maxTxFeeZat: 10_000_000n, yellowbackMaxTxFeeZat: 1_000_000_000n,
    });
  });
  it("ignores an older node or a missing or malformed block (the S-6 floor then applies)", () => {
    expect(networkFeesOf({ rpcversion: 7, params: { fees: { network: NETWORK_FEES } } })).toBeUndefined();
    expect(networkFeesOf({ rpcversion: 8, params: {} })).toBeUndefined();
    expect(networkFeesOf({ rpcversion: 8, params: { fees: { network: { ...NETWORK_FEES, plain: { zatPerKB: -1 } } } } })).toBeUndefined();
  });
  it("a fallback price (no attested price) is null", () => {
    const fb = networkFeesOf({ rpcversion: 8, params: { fees: { network: { ...NETWORK_FEES, priceMicroUsd: null, priceSource: "fallback" } } } });
    expect(fb?.priceMicroUsd).toBeNull();
    expect(fb?.priceSource).toBe("fallback");
  });
});

describe("networkFee", () => {
  it("CFeeRate::GetFee: rounds down, never 0 for a positive rate", () => {
    expect(sizeFee(12_500_000n, 1234)).toBe(15_425_000n);
    expect(sizeFee(100n, 5)).toBe(100n);
    expect(sizeFee(0n, 5)).toBe(0n);
  });
  it("plain, or no rates: the S-6 floor", () => {
    const tx = draft(108);
    expect(networkFee(tx, "plain", fees)).toBe(feeFloor(tx));
    expect(networkFee(tx, "yellowback", undefined)).toBe(feeFloor(tx));
  });
  it("PQ and Yellowback: their rate by size, at least the floor, at most the Yellowback cap", () => {
    const tx = draft(1650); // a Falcon spend's scriptSig
    const size = serializeTx(tx).length;
    expect(networkFee(tx, "pq", fees)).toBe((5_000_000n * BigInt(size)) / 1000n);
    expect(networkFee(tx, "yellowback", fees)).toBe((12_500_000n * BigInt(size)) / 1000n);
    const low = { ...fees, yellowbackZatPerKB: 1n };
    expect(networkFee(tx, "yellowback", low)).toBe(feeFloor(tx));
    const capped = { ...fees, yellowbackMaxTxFeeZat: 123_456n };
    expect(networkFee(tx, "yellowback", capped)).toBe(123_456n);
  });
  it("the facilitator's cap and allowhighfees", () => {
    expect(networkFeeCap("plain", 100_000n, fees)).toBe(100_000n);
    expect(networkFeeCap("yellowback", 100_000n, fees)).toBe(1_000_000_000n);
    expect(networkFeeCap("pq", 100_000n, undefined)).toBe(100_000n);
    expect(needsHighFees(10_000_000n, "yellowback", fees)).toBe(false);
    expect(needsHighFees(10_000_001n, "yellowback", fees)).toBe(true);
    expect(needsHighFees(1_000_000_001n, "yellowback", fees)).toBe(false);
    expect(needsHighFees(50_000_000n, "plain", fees)).toBe(false);
  });
});

describe("the YED exact payment at the Yellowback rate", () => {
  const payer = testKey(1);
  const merchant = testKey(2);
  const merchantYr = encodeAddress(NETWORK, "yed", hash160(pubkeyFromPriv(merchant.priv)));
  const yedReq = (extra: Record<string, unknown> = {}) => ({ ...requirements(merchantYr, "2500", { confirmationPolicy: { confirmations: -1 }, ...extra }), asset: "YED" });
  let node: FakeNode;
  let facilitator: exact.ExactYcashFacilitatorScheme;

  beforeEach(() => {
    node = new FakeNode();
    node.yellowback = true;
    facilitator = new exact.ExactYcashFacilitatorScheme(node, { settlementStore: new InMemorySettlementStore(), confirmationTimeoutMs: 0, yellowback: true });
  });

  async function pay(rates: Record<string, unknown>): Promise<string> {
    node.networkFees = rates;
    node.addToken(5_000, payer.script);
    node.addCoin(500_000_000n, payer.script);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    return ((await client.createPaymentPayload(2, yedReq())).payload as { transaction: string }).transaction;
  }
  const feeOf = (hex: string) => txFee(parseTx(hex), [10_000n, 500_000_000n]);

  it("pays the Yellowback rate by size; verify accepts it above the plain cap; settle passes allowhighfees above -maxtxfee", async () => {
    // $0.05 at the doc's $0.05/YEC example: 1 YEC/KB, so a ≈ 400-byte TRANSFER pays ≈ 0.4 YEC.
    const hex = await pay({ ...NETWORK_FEES, yellowback: { ...NETWORK_FEES.yellowback, zatPerKB: 100_000_000 } });
    const fee = feeOf(hex);
    // priced on the draft, signatures at their largest: at least the signed tx's fee, a few bytes over it
    const signed = networkFee(parseTx(hex), "yellowback", networkFeesOf({ rpcversion: 8, params: { fees: { network: node.networkFees } } }));
    expect(fee >= signed && fee - signed <= 1_000_000n).toBe(true);
    expect(fee).toBeGreaterThan(10_000_000n);
    expect(fee).toBeLessThan(1_000_000_000n);
    const r = await facilitator.settle(paymentPayload(yedReq(), hex), yedReq());
    expect(r).toMatchObject({ success: true });
    expect(node.allowHighFees).toEqual([true]);
  });
  it("below -maxtxfee: no allowhighfees", async () => {
    const hex = await pay(NETWORK_FEES); // 12,500,000 zat/KB: ≈ 5,000,000 zat
    expect(feeOf(hex)).toBeLessThan(10_000_000n);
    expect(await facilitator.settle(paymentPayload(yedReq(), hex), yedReq())).toMatchObject({ success: true });
    expect(node.allowHighFees).toEqual([false]);
  });
  it("above the node's Yellowback cap: fee_too_high", async () => {
    const hex = await pay({ ...NETWORK_FEES, yellowback: { ...NETWORK_FEES.yellowback, zatPerKB: 100_000_000 } });
    node.networkFees = { ...NETWORK_FEES, yellowback: { ...NETWORK_FEES.yellowback, maxTxFeeZat: 1_000_000 } };
    const v = await facilitator.verify(paymentPayload(yedReq(), hex), yedReq());
    expect(v).toMatchObject({ isValid: false, invalidReason: exact.ERR_FEE_TOO_HIGH });
  });
  it("an rpcversion-7 node: the S-6 floor and the plain cap, as before", async () => {
    node.addToken(5_000, payer.script);
    node.addCoin(1_000_000n, payer.script);
    const client = new exact.ExactYcashScheme(new exact.LocalKeySigner(payer.wif, new FakeUtxoSource(node)));
    const hex = ((await client.createPaymentPayload(2, yedReq())).payload as { transaction: string }).transaction;
    expect(txFee(parseTx(hex), [10_000n, 1_000_000n])).toBe(feeFloor(parseTx(hex)));
    expect(await facilitator.settle(paymentPayload(yedReq(), hex), yedReq())).toMatchObject({ success: true });
    expect(node.allowHighFees).toEqual([false]);
  });
});

describe("channels", () => {
  it("the YED close fee follows the Yellowback rate: Falcon below SLH-DSA, both above the S-6 defaults", () => {
    const falcon = yedCloseNetworkFee(true, fees);
    const slh = yedCloseNetworkFee(false, fees);
    expect(falcon).toBeGreaterThan(12_000n);
    expect(slh).toBeGreaterThan(falcon);
    expect(yedCloseNetworkFee(true, undefined)).toBeLessThan(12_000n); // the S-6 floor of the draft
  });
  it("classifies the absurd-fee refusal of both lines", () => {
    expect(classifySendError(-26, "AcceptToMemoryPool: absurdly high fees ab, 50000000 > 10000000")).toBe("absurd-fee");
    expect(classifySendError(-26, "absurdly-high-fee")).toBe("absurd-fee");
  });
  it("relays a YED channel transaction refused as absurdly high once more with allowhighfees; never a YEC one", async () => {
    const calls: boolean[] = [];
    const chain = {
      async sendRawTransaction(hex: string, allow?: boolean): Promise<string> {
        calls.push(allow === true);
        if (!allow) throw new SendRawTransactionError(new RpcError(-26, "256: absurdly-high-fee", "sendrawtransaction"));
        return hex;
      },
    };
    expect(await sendChannelTransaction(chain, "aa", true)).toBe("aa");
    expect(calls).toEqual([false, true]);
    await expect(sendChannelTransaction(chain, "aa", false)).rejects.toBeInstanceOf(SendRawTransactionError);
  });
});
