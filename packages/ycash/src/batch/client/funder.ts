// Funding a channel. A funder returns the signed funding transaction paying V to the channel's
// P2SH script; it never broadcasts (the server relays it). Two funders: a node wallet over RPC, and
// local keys over known coins (channel/funding.ts).
import { heldOutpoints, InMemoryCoinReservationStore, type CoinReservationStore } from "../../store/coinReservations.js";
import { buildFundingTx, signFundingTx, type FundingInput } from "../../channel/funding.js";
import { buildYedFundingTx, yedChannelValue } from "../../channel/yed.js";
import { ASSET_YED, type YcashNetwork } from "../../constants.js";
import { RPC_METHOD_NOT_FOUND, RpcError } from "../../node/errors.js";
import { selectTokenCoins, type TokenCoin } from "../../yed/build.js";
import type { YcashRpc } from "../../node/rpc.js";
import { yecToZat } from "../../node/amount.js";
import { addressToScript, encodeAddress } from "../../tx/address.js";
import { equalBytes, hexToBytes } from "../../tx/bytes.js";
import { hash160 } from "../../tx/hash.js";
import { pubkeyFromPriv } from "../../tx/keys.js";
import { p2pkhHash, p2pkhScript } from "../../tx/script.js";
import { serializeTxHex, txid as txidOf } from "../../tx/tx.js";

export interface FundingRequest {
  network: YcashNetwork;
  redeemScript: Uint8Array;
  /** V, zatoshis */
  value: bigint;
  /** the branch id to sign under */
  branchId: number;
  /** YEC by default. YED: the funding is a TRANSFER assigning `deposit` cents to the channel output. */
  asset?: string;
  /** D, in the asset's unit (YED: the cents to assign) */
  deposit?: bigint;
}

export interface ChannelFunder {
  /** The signed funding transaction, hex; the channel output is at vout 0. */
  fund(req: FundingRequest): Promise<string>;
}

/** `yed_listunspent` row (ycash-dd/src/rpc/yellowbackwallet.cpp:699-718). */
interface YedCoinRow {
  txid: string;
  vout: number;
  cents: number;
  valueZat: number;
  address: string;
  confirmations: number;
  spentUnconfirmed: boolean;
  /** Always true for the Yellowback wallet's own YED outputs: not a "taken" marker. */
  locked: boolean;
}

type FunderRpc = Pick<YcashRpc, "listUnspent" | "call" | "signRawTransactionWithWallet">;

/** The wallet's YED outputs, or none on a node without the Yellowback wallet. */
async function walletTokens(rpc: FunderRpc): Promise<YedCoinRow[]> {
  try {
    return await rpc.call<YedCoinRow[]>("yed_listunspent");
  } catch (e) {
    if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) return [];
    throw e;
  }
}

/**
 * Funds from a node wallet's confirmed transparent P2PKH coins (never coinbase): the SDK builds the
 * transaction at the fee floor, the wallet signs (`signrawtransaction hex`), and the inputs are
 * locked so the wallet cannot spend them again before the server relays (plan X-F13). Coins holding
 * YED are never spent as plain YEC (that would burn them, plan Y-4); a YED channel spends them in a
 * TRANSFER that assigns D to the channel and returns the rest as YED change.
 */
export function rpcWalletFunder(rpc: FunderRpc, opts: { reservations?: CoinReservationStore; holdMs?: number } = {}): ChannelFunder {
  // YED outputs this funder signed away. The Yellowback wallet keeps all its YED outputs locked
  // against plain YEC spends (ycash-dd/src/yellowback/wallet.cpp:404-410), so a lock marks nothing.
  const reservations = opts.reservations ?? new InMemoryCoinReservationStore();
  return {
    async fund(req) {
      const reserved = await heldOutpoints(reservations, 0); // a funding never expires: held for holdMs
      const tokenRows = await walletTokens(rpc);
      const tokenKeys = new Set(tokenRows.map((r) => `${r.txid}:${r.vout}`));
      const coins = (await rpc.listUnspent(1))
        .filter((u) => u.spendable && !u.generated && p2pkhHash(hexToBytes(u.scriptPubKey)) !== null && !tokenKeys.has(`${u.txid}:${u.vout}`))
        .map((u) => ({ outpoint: { txid: u.txid, vout: u.vout }, value: yecToZat(u.amount), scriptPubKey: hexToBytes(u.scriptPubKey) }))
        .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
      const changeScript = addressToScript(await rpc.call<string>("getrawchangeaddress"), req.network);
      if (req.asset === ASSET_YED) {
        const free = tokenRows.filter((r) => !reserved.has(`${r.txid}:${r.vout}`));
        return fundYed(rpc, req, free, coins, changeScript, async (outpoints, spentBy) => {
          await reservations.reserve(outpoints, { spentBy, expiryHeight: 0, untilMs: Date.now() + (opts.holdMs ?? 1_800_000) });
        });
      }
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

/** The YED funding TRANSFER from the wallet's confirmed, unlocked YED outputs (plan Y-7). */
async function fundYed(
  rpc: FunderRpc,
  req: FundingRequest,
  rows: readonly YedCoinRow[],
  yecCoins: readonly FundingInput[],
  yecChange: Uint8Array,
  reserve: (outpoints: string[], spentBy: string) => Promise<void>,
): Promise<string> {
  if (req.deposit === undefined) throw new Error("a YED funding needs the deposit in cents");
  const tokens: TokenCoin[] = rows
    .filter((r) => r.confirmations >= 1 && !r.spentUnconfirmed)
    .map((r) => ({ outpoint: { txid: r.txid, vout: r.vout }, cents: r.cents, value: BigInt(r.valueZat), scriptPubKey: addressToScript(r.address) }));
  const sel = selectTokenCoins(tokens, Number(req.deposit));
  const built = buildYedFundingTx({
    redeemScript: req.redeemScript,
    depositCents: req.deposit,
    closeFee: req.value - yedChannelValue(0n),
    tokens: sel.coins,
    yecCoins,
    yedChangeScript: addressToScript(await rpc.call<string>("yed_getnewaddress"), req.network),
    yecChangeScript: yecChange,
  });
  const signed = await rpc.signRawTransactionWithWallet(serializeTxHex(built.tx));
  if (!signed.complete) throw new Error(`the wallet could not sign the funding inputs: ${JSON.stringify(signed.errors)}`);
  await rpc.call("lockunspent", [false, built.inputs.map((i) => i.outpoint)]);
  await reserve(sel.coins.map((t) => `${t.outpoint.txid}:${t.outpoint.vout}`), txidOf(hexToBytes(signed.hex)));
  return signed.hex;
}

/** Funds a YEC channel from known coins with local keys; `privKeys[i]` owns `coins[i]`. */
export function localKeyFunder(coins: readonly FundingInput[], privKeys: readonly Uint8Array[], changeScript: Uint8Array): ChannelFunder {
  return {
    async fund(req) {
      if (req.asset === ASSET_YED) throw new Error("localKeyFunder funds YEC channels; a YED channel needs localKeyYedFunder or rpcWalletFunder");
      const tx = buildFundingTx({ inputs: coins, redeemScript: req.redeemScript, value: req.value, changeScript });
      return serializeTxHex(signFundingTx(tx, coins, privKeys, req.branchId));
    },
  };
}

/** Where `utxoSourceFunder` lists the key's coins (exact's RpcUtxoSource fits). */
export interface FundingCoinSource {
  listCoins(address: string): Promise<{ txid: string; vout: number; value: bigint; scriptPubKey: Uint8Array }[]>;
  /** As UtxoSource.reserve: holds the funding's coins (it never expires, so 0); false = select again. */
  reserve?(coins: readonly { txid: string; vout: number }[], spend: { txid: string; expiryHeight: number }): Promise<boolean>;
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
  /** One selection; undefined when another spend took one of the picked coins meanwhile. */
  const fundOnce = async (req: FundingRequest): Promise<string | undefined> => {
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
      if (source.reserve && !(await source.reserve(picked.map((c) => c.outpoint), { txid: txidOf(hexToBytes(hex)), expiryHeight: 0 }))) return undefined;
      for (const c of picked) used.add(`${c.outpoint.txid}:${c.outpoint.vout}`);
      return hex;
    }
    throw new Error(`the coins of ${address} cannot fund ${req.value} zatoshis`);
  };
  return {
    async fund(req) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const hex = await fundOnce(req);
        if (hex !== undefined) return hex;
      }
      throw new Error("coins kept being taken by another spend of this key; try again");
    },
  };
}

/**
 * Funds a YED channel with local keys: `tokens` (confirmed YED outputs) and `yecCoins` (plain YEC
 * for V and the fee), each owned by the key `keyOf` returns for its outpoint.
 */
export function localKeyYedFunder(
  tokens: readonly TokenCoin[],
  yecCoins: readonly FundingInput[],
  keyOf: (outpoint: { txid: string; vout: number }) => Uint8Array,
  change: { yed: Uint8Array; yec: Uint8Array },
): ChannelFunder {
  return {
    async fund(req) {
      if (req.asset !== ASSET_YED || req.deposit === undefined) throw new Error("localKeyYedFunder funds YED channels: asset YED and the deposit in cents");
      const sel = selectTokenCoins(tokens, Number(req.deposit));
      const built = buildYedFundingTx({
        redeemScript: req.redeemScript,
        depositCents: req.deposit,
        closeFee: req.value - yedChannelValue(0n),
        tokens: sel.coins,
        yecCoins,
        yedChangeScript: change.yed,
        yecChangeScript: change.yec,
      });
      return serializeTxHex(signFundingTx(built.tx, built.inputs, built.inputs.map((i) => keyOf(i.outpoint)), req.branchId));
    },
  };
}
