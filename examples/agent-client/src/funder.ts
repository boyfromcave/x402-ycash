// The channel funder of a WIF signer, for both assets. YEC goes through the mechanism's
// utxoSourceFunder; that funder refuses YED, so a YED channel is funded here from the key's token
// outputs (listTokens) and plain YEC coins (listCoins) with localKeyYedFunder, the coins then held
// in the source's reservations as utxoSourceFunder holds its own. (packages/cli/src/funder.ts is the
// same function: a utxoSourceFunder YED path in the mechanism would replace both.)
import { ASSET_YED, batch, type exact, tx, utxoSourceFunder } from "x402-ycash-mechanism";

type ChannelFunder = batch.client.ChannelFunder;

export function wifChannelFunder(privKey: Uint8Array, source: exact.UtxoSource): ChannelFunder {
  const yec = utxoSourceFunder(privKey, source);
  const hash = tx.hash160(tx.pubkeyFromPriv(privKey));
  const script = tx.p2pkhScript(hash);
  return {
    async fund(req) {
      if (req.asset !== ASSET_YED) return yec.fund(req);
      if (!source.listTokens) throw new Error("this UtxoSource cannot list YED outputs");
      const address = tx.encodeAddress(req.network, "p2pkh", hash);
      const tokens = (await source.listTokens(address)).filter((t) => tx.equalBytes(t.scriptPubKey, script));
      const coins = (await source.listCoins(address))
        .filter((c) => tx.equalBytes(c.scriptPubKey, script))
        .map((c) => ({ outpoint: { txid: c.txid, vout: c.vout }, value: c.value, scriptPubKey: c.scriptPubKey }));
      // YED and YEC change both return to the key (its ye… and s… forms share the script).
      const hex = await batch.client.localKeyYedFunder(tokens, coins, () => privKey, { yed: script, yec: script }).fund(req);
      const signed = tx.parseTx(hex);
      // A funding never expires (expiryHeight 0): the source holds its coins for a while instead.
      if (source.reserve && !(await source.reserve(signed.vin.map((i) => i.prevout), { txid: tx.txid(signed), expiryHeight: 0 }))) {
        throw new Error("another spend of this key took one of the funding's coins; try again");
      }
      return hex;
    },
  };
}
