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
// The spec example's keys: SHA-256("x402-ycash spec example client key C") and "… server key S", as public keys.
const SPEC_C = "03efe7ffc36c3fed9fcd4f1b8de29a5a5a44faa7bf8418334518cf3a765df54ba6";
const SPEC_S = "0289bb2b0ac2056bbc117fcee21dc12b8147066cea2d6ff9a1a650b8e444378435";
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
    clientPubKey: SPEC_C, serverPubKey: SPEC_S, refundHeight,
    redeemScript: hex(C.buildChannelScript({ clientPubKey: h(SPEC_C), serverPubKey: h(SPEC_S), refundHeight })),
    hash160: hex(T.hash160(C.buildChannelScript({ clientPubKey: h(SPEC_C), serverPubKey: h(SPEC_S), refundHeight }))),
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
