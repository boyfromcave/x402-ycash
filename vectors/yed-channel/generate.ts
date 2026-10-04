// Generates vectors/yed-channel/channel_yed.json: the YED channel's funding TRANSFER, vouchers under
// the dollar floor (X-7) with their TRANSFER at vout 2, completed closes and the refund with its
// payload, for fixed keys, coins and branch id (plan X-2, X3; specs/scheme_batch_settlement_ycash.md,
// "YED Channels").
//
//   npx tsx vectors/yed-channel/generate.ts
//
// Offline and deterministic (RFC 6979 signatures). The same builders' spends are relayed, verified
// by the overlay (yed_validaterawtransaction: ok, burned 0) and mined on both node lines by
// packages/ycash/test/devnet/yed.devnet.test.ts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../../packages/ycash/src/channel/index.js";
import * as T from "../../packages/ycash/src/tx/index.js";
import * as Y from "../../packages/ycash/src/yed/index.js";

const h = T.hexToBytes;
const hex = T.bytesToHex;
const NET = "ycash:regtest" as const;
const BRANCH = 0x19bd2d2f; // Canopy, the branch of both devnets and of mainnet (plan X-F9)
const cPriv = h("11".repeat(32));
const sPriv = h("22".repeat(32));
const fPriv = h("33".repeat(32)); // the funder's wallet key
const cPub = T.pubkeyFromPriv(cPriv);
const sPub = T.pubkeyFromPriv(sPriv);
const fScript = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(fPriv)));
const refundHeight = 3_101_234;
const depositCents = 2_000n;
const closeFee = C.DEFAULT_CLOSE_FEE;
const redeemScript = C.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight });
const payTo = T.encodeAddress(NET, "yed", h("aa".repeat(20)));
// The open's returnAddress: the funder's Yellowback address (a P2PKH, as YED needs), never C's.
const returnAddress = T.encodeAddress(NET, "yed", T.hash160(T.pubkeyFromPriv(fPriv)));
const clientScript = T.addressToScript(returnAddress, NET);

// funding: a token coin of $25.00 and a YEC coin, both the funder's
const token: Y.TokenCoin = { outpoint: { txid: "a1".repeat(32), vout: 1 }, cents: 2_500, value: 10_000n, scriptPubKey: fScript };
const yecCoin: Y.YecCoin = { outpoint: { txid: "b2".repeat(32), vout: 0 }, value: 1_000_000n, scriptPubKey: fScript };
const built = C.buildYedFundingTx({ redeemScript, depositCents, closeFee, tokens: [token], yecCoins: [yecCoin], yedChangeScript: fScript, yecChangeScript: fScript });
const funding = C.signFundingTx(built.tx, built.inputs, [fPriv, fPriv], BRANCH);

const channel = C.channelFromScript({
  outpoint: { txid: T.txid(funding), vout: C.FUNDING_VOUT },
  redeemScript, value: C.yedChannelValue(closeFee), closeFee, payToScript: T.addressToScript(payTo, NET),
});
const layout = C.yedVoucherLayout(depositCents);

// 100: the first voucher (pre-pays $1.00); 101; 1,900 (client keeps exactly $1.00); 1,901 and 1,999
// (the remainder rule: all of D to the server); 2,000 (exhausted)
const vouchers = [100n, 101n, 1_900n, 1_901n, 1_999n, 2_000n].map((cumulative) => {
  const v = C.buildVoucher({ channel, cumulative, clientScript, clientPrivKey: cPriv, branchId: BRANCH, layout });
  const close = C.completeVoucher(v, channel, sPriv, BRANCH);
  const split = Y.yedChannelSplit(Number(depositCents), Number(cumulative));
  return {
    cumulative: cumulative.toString(),
    serverCents: split.serverCents,
    clientCents: split.clientCents,
    assignments: C.yedVoucherAssignments(depositCents, cumulative),
    sighash: hex(C.voucherSighash(v, channel, BRANCH)),
    voucher: T.serializeTxHex(v),
    close: T.serializeTxHex(close),
    closeTxid: T.txid(close),
    outputs: close.vout.map((o) => ({ value: o.value.toString(), scriptPubKey: hex(o.scriptPubKey) })),
  };
});
const refund = C.buildYedRefund({ channel, depositCents, clientPrivKey: cPriv, toScript: clientScript, branchId: BRANCH });

const doc = {
  description:
    "YED payment channel (batch-settlement, plan X3): the funding TRANSFER (D cents to the P2SH output of V = 2 × TOKEN_VALUE + closeFee), vouchers under the dollar floor with their TRANSFER at vout 2, completed closes, the refund with its TRANSFER of all of D to the client (vout 1). The client's YED (voucher vout 1, the refund) goes to the open's returnAddress (clientScript, a P2PKH). The funding keeps nExpiryHeight 0 (still accepted) so its bytes stay those of the earlier vector. Offline, deterministic; the builders' spends are mined on both lines by test/devnet/yed.devnet.test.ts.",
  branchId: BRANCH.toString(16),
  channel: {
    clientPriv: hex(cPriv), serverPriv: hex(sPriv), funderPriv: hex(fPriv), refundHeight, depositCents: depositCents.toString(),
    redeemScript: hex(redeemScript), scriptPubKey: hex(C.channelScriptPubKey(redeemScript)),
    value: channel.value.toString(), closeFee: closeFee.toString(), payTo, returnAddress, clientScript: hex(clientScript),
  },
  funding: {
    token: { outpoint: token.outpoint, cents: token.cents, value: token.value.toString() },
    yecCoin: { outpoint: yecCoin.outpoint, value: yecCoin.value.toString() },
    assignments: built.assignments, opReturnIndex: built.opReturnIndex, fee: built.fee.toString(),
    tx: T.serializeTxHex(funding), txid: T.txid(funding),
  },
  vouchers,
  refund: { lockTime: refund.lockTime, sequence: refund.vin[0]!.sequence, assignments: [{ vout: 1, cents: Number(depositCents) }], tx: T.serializeTxHex(refund), txid: T.txid(refund) },
};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "channel_yed.json"), JSON.stringify(doc, null, 2) + "\n");
