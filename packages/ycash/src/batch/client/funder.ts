// Funding a channel. A funder returns the signed funding transaction paying V to the channel's
// P2SH script; it never broadcasts (the server relays it). Two funders: a node wallet over RPC, and
// local keys over known coins (channel/funding.ts).
import { buildFundingTx, signFundingTx, type FundingInput } from "../../channel/funding.js";
import type { YcashNetwork } from "../../constants.js";
import type { YcashRpc } from "../../node/rpc.js";
import { yecToZat } from "../../node/amount.js";
import { addressToScript, encodeAddress } from "../../tx/address.js";
import { equalBytes, hexToBytes } from "../../tx/bytes.js";
import { hash160 } from "../../tx/hash.js";
import { pubkeyFromPriv } from "../../tx/keys.js";
import { p2pkhHash, p2pkhScript } from "../../tx/script.js";
import { serializeTxHex } from "../../tx/tx.js";

export interface FundingRequest {
  network: YcashNetwork;
  redeemScript: Uint8Array;
  /** V, zatoshis */
  value: bigint;
  /** the branch id to sign under */
  branchId: number;
}

export interface ChannelFunder {
  /** The signed funding transaction, hex; the channel output is at vout 0. */
  fund(req: FundingRequest): Promise<string>;
}

/**
 * Funds from a node wallet's confirmed transparent P2PKH coins (never coinbase): the SDK builds the
 * transaction at the fee floor, the wallet signs (`signrawtransaction hex`), and the inputs are
 * locked so the wallet cannot spend them again before the server relays (plan X-F13).
 */
export function rpcWalletFunder(rpc: Pick<YcashRpc, "listUnspent" | "call" | "signRawTransactionWithWallet">): ChannelFunder {
  return {
    async fund(req) {
      const coins = (await rpc.listUnspent(1))
        .filter((u) => u.spendable && !u.generated && p2pkhHash(hexToBytes(u.scriptPubKey)) !== null)
        .map((u) => ({ outpoint: { txid: u.txid, vout: u.vout }, value: yecToZat(u.amount), scriptPubKey: hexToBytes(u.scriptPubKey) }))
        .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
      const changeScript = addressToScript(await rpc.call<string>("getrawchangeaddress"), req.network);
      const picked: FundingInput[] = [];
      for (const c of coins) {
        picked.push(c);
        try {
          const tx = buildFundingTx({ inputs: picked, redeemScript: req.redeemScript, value: req.value, changeScript });
          const signed = await rpc.signRawTransactionWithWallet(serializeTxHex(tx));
          if (!signed.complete) throw new Error(`the wallet could not sign the funding inputs: ${JSON.stringify(signed.errors)}`);
          await rpc.call("lockunspent", [false, picked.map((i) => i.outpoint)]);
          return signed.hex;
        } catch (e) {
          if (!/cannot pay/.test((e as Error).message)) throw e;
        }
      }
      throw new Error(`the wallet's confirmed coins cannot fund ${req.value} zatoshis`);
    },
  };
}

/** Funds from known coins with local keys; `privKeys[i]` owns `coins[i]`. */
export function localKeyFunder(coins: readonly FundingInput[], privKeys: readonly Uint8Array[], changeScript: Uint8Array): ChannelFunder {
  return {
    async fund(req) {
      const tx = buildFundingTx({ inputs: coins, redeemScript: req.redeemScript, value: req.value, changeScript });
      return serializeTxHex(signFundingTx(tx, coins, privKeys, req.branchId));
    },
  };
}

/** Where `utxoSourceFunder` lists the key's coins (exact's RpcUtxoSource fits). */
export interface FundingCoinSource {
  listCoins(address: string): Promise<{ txid: string; vout: number; value: bigint; scriptPubKey: Uint8Array }[]>;
}

/**
 * Funds from one local P2PKH key's coins as a UtxoSource lists them (largest first, until they
 * cover V and the fee), change back to the key. The localKeyFunder for an agent that holds a WIF
 * and reads its coins from a node or a light client. Coins it signed are kept out of the next
 * selection, since the server, not the funder, broadcasts the funding transaction.
 */
export function utxoSourceFunder(privKey: Uint8Array, source: FundingCoinSource, compressed = true): ChannelFunder {
  const pub = pubkeyFromPriv(privKey, compressed);
  const script = p2pkhScript(hash160(pub));
  const used = new Set<string>();
  return {
    async fund(req) {
      const address = encodeAddress(req.network, "p2pkh", hash160(pub));
      const coins = (await source.listCoins(address))
        .filter((c) => equalBytes(c.scriptPubKey, script) && !used.has(`${c.txid}:${c.vout}`))
        .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
        .map((c) => ({ outpoint: { txid: c.txid, vout: c.vout }, value: c.value, scriptPubKey: c.scriptPubKey }));
      for (let n = 1; n <= coins.length; n++) {
        const picked = coins.slice(0, n);
        let hex: string;
        try {
          hex = await localKeyFunder(picked, picked.map(() => privKey), script).fund(req);
        } catch (e) {
          if (/cannot pay/.test((e as Error).message)) continue;
          throw e;
        }
        for (const c of picked) used.add(`${c.outpoint.txid}:${c.outpoint.vout}`);
        return hex;
      }
      throw new Error(`the coins of ${address} cannot fund ${req.value} zatoshis`);
    },
  };
}
