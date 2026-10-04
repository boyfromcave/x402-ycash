// Generates vectors/channel/channel_yec.json: the YEC channel's redeem script, voucher, completed
// close and refund for fixed keys, outpoint and branch id (plan X-2, X2).
//
//   npx tsx vectors/channel/generate.ts
//
// Offline and deterministic (RFC 6979 signatures). The same builders' spends are relayed and mined
// on both node lines by packages/ycash/test/devnet/channel_yec.devnet.test.ts; the redeem-script case
// is the example of specs/scheme_batch_settlement_ycash.md.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../../packages/ycash/src/channel/index.js";
import * as T from "../../packages/ycash/src/tx/index.js";

const h = T.hexToBytes;
const hex = T.bytesToHex;
const BRANCH = 0x19bd2d2f; // Canopy, the branch of both devnets and of mainnet (plan X-F9)
const cPriv = h("11".repeat(32));
const sPriv = h("22".repeat(32));
const cPub = T.pubkeyFromPriv(cPriv);
const sPub = T.pubkeyFromPriv(sPriv);
const refundHeight = 3_101_234;
const redeemScript = C.buildChannelScript({ clientPubKey: cPub, serverPubKey: sPub, refundHeight });
const payTo = T.encodeAddress("ycash:regtest", "p2pkh", h("aa".repeat(20)));
const channel = C.channelFromScript({
  outpoint: { txid: "7d3a" + "00".repeat(28) + "e91c", vout: 0 },
  redeemScript, value: 1_001_500n, closeFee: C.DEFAULT_CLOSE_FEE, payToScript: T.addressToScript(payTo, "ycash:regtest"),
});
const clientScript = T.p2pkhScript(T.hash160(cPub));

const vouchers = [2000n, 26_000n, 999_947n, 1_000_000n].map((cumulative) => {
  const v = C.buildVoucher({ channel, cumulative, clientScript, clientPrivKey: cPriv, branchId: BRANCH });
  const close = C.completeVoucher(v, channel, sPriv, BRANCH);
  return {
    cumulative: cumulative.toString(),
    sighash: hex(C.voucherSighash(v, channel, BRANCH)),
    voucher: T.serializeTxHex(v),
    close: T.serializeTxHex(close),
    closeTxid: T.txid(close),
    outputs: close.vout.map((o) => ({ value: o.value.toString(), scriptPubKey: hex(o.scriptPubKey) })),
  };
});
const refund = C.buildRefund({ channel, clientPrivKey: cPriv, toScript: clientScript, branchId: BRANCH });

const doc = {
  description: "YEC payment channel (batch-settlement): redeem scripts, vouchers, completed closes, refund. Offline, deterministic; the builders' spends are mined on both lines by test/devnet/channel_yec.devnet.test.ts.",
  branchId: BRANCH.toString(16),
  specExample: {
    clientPubKey: "02" + "c1".repeat(32), serverPubKey: "03" + "5e".repeat(32), refundHeight,
    redeemScript: hex(C.buildChannelScript({ clientPubKey: h("02" + "c1".repeat(32)), serverPubKey: h("03" + "5e".repeat(32)), refundHeight })),
    hash160: "2a658b51612cf2df64fe5375e8253bdec61f3c64",
  },
  channel: {
    clientPriv: hex(cPriv), serverPriv: hex(sPriv), clientPubKey: hex(cPub), serverPubKey: hex(sPub), refundHeight,
    redeemScript: hex(redeemScript), scriptPubKey: hex(C.channelScriptPubKey(redeemScript)),
    outpoint: channel.outpoint, value: channel.value.toString(), closeFee: channel.closeFee.toString(), payTo, clientScript: hex(clientScript),
  },
  vouchers,
  refund: { lockTime: refund.lockTime, sequence: refund.vin[0]!.sequence, tx: T.serializeTxHex(refund), txid: T.txid(refund) },
};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "channel_yec.json"), JSON.stringify(doc, null, 2) + "\n");
