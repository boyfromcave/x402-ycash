// Funding a channel. A funder returns the signed funding transaction paying V to the channel's
// P2SH script; it never broadcasts (the server relays it). Two funders: a node wallet over RPC, and
// local keys over known coins (channel/funding.ts).
import { heldOutpoints, InMemoryCoinReservationStore, type CoinReservation, type CoinReservationStore } from "../../store/coinReservations.js";
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
import { parseTx, serializeTxHex, txid as txidOf } from "../../tx/tx.js";

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
  /** The tip the client saw: a funder releases coins of earlier fundings that expired by it. */
  tip?: number;
  /** The funding's nExpiryHeight (plan X-F52); 0 or absent = never expires. Its coins are held until then. */
  expiryHeight?: number;
}

export interface ChannelFunder {
  /** The signed funding transaction, hex; the channel output is at vout 0. */
  fund(req: FundingRequest): Promise<string>;
  /**
   * The funder's own address for the channel's remainder (the open's `returnAddress`): a wallet
   * address, or the WIF key's. For YED, a P2PKH address.
   */
  returnAddress?(req: { network: YcashNetwork; asset: string }): Promise<string>;
}

/**
 * How a funding holds its coins: until its expiry height, or, for a funding that never expires
 * (expiryHeight 0), for `holdMs`.
 */
function holdOf(req: FundingRequest, spentBy: string, holdMs: number): CoinReservation {
  const expiryHeight = req.expiryHeight ?? 0;
  return { spentBy, expiryHeight, ...(expiryHeight === 0 ? { untilMs: Date.now() + holdMs } : {}) };
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

const DEFAULT_HOLD_MS = 1_800_000;

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
 * locked so the wallet cannot spend them again before the server relays (plan X-F13). The lock is
 * lifted once the funding has expired unmined (plan X-F52). Coins holding YED are never spent as
 * plain YEC (that would burn them, plan Y-4); a YED channel spends them in a TRANSFER that assigns D
 * to the channel and returns the rest as YED change. The remainder returns to a new wallet address.
 */
export function rpcWalletFunder(rpc: FunderRpc, opts: { reservations?: CoinReservationStore; holdMs?: number } = {}): ChannelFunder {
  // YED outputs this funder signed away. The Yellowback wallet keeps all its YED outputs locked
  // against plain YEC spends (ycash-dd/src/yellowback/wallet.cpp:404-410), so a lock marks nothing.
  const reservations = opts.reservations ?? new InMemoryCoinReservationStore();
  // Plain YEC coins this funder locked (lockunspent), by the expiry of the funding that spends them.
  const locked = new InMemoryCoinReservationStore();
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
  /** Unlocks the plain coins of fundings that expired unmined; a coin a block spent just drops out. */
  const unlockExpired = async (tip: number): Promise<void> => {
    const before = [...(await locked.list()).keys()];
    if (before.length === 0) return;
    const held = await heldOutpoints(locked, tip);
    const lapsed = before.filter((o) => !held.has(o)).map((o) => ({ txid: o.slice(0, 64), vout: Number(o.slice(65)) }));
    if (lapsed.length > 0) await rpc.call("lockunspent", [true, lapsed]).catch(() => undefined); // spent coins cannot be unlocked; nothing to do
  };
  return {
    async returnAddress(req) {
      return rpc.call<string>(req.asset === ASSET_YED ? "yed_getnewaddress" : "getrawchangeaddress");
    },
    async fund(req) {
      const tip = req.tip ?? 0;
      await unlockExpired(tip);
      const reserved = await heldOutpoints(reservations, tip);
      const tokenRows = await walletTokens(rpc);
      const tokenKeys = new Set(tokenRows.map((r) => `${r.txid}:${r.vout}`));
      const coins = (await rpc.listUnspent(1))
        .filter((u) => u.spendable && !u.generated && p2pkhHash(hexToBytes(u.scriptPubKey)) !== null && !tokenKeys.has(`${u.txid}:${u.vout}`))
        .map((u) => ({ outpoint: { txid: u.txid, vout: u.vout }, value: yecToZat(u.amount), scriptPubKey: hexToBytes(u.scriptPubKey) }))
        .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
      const changeScript = addressToScript(await rpc.call<string>("getrawchangeaddress"), req.network);
      const lock = async (inputs: readonly FundingInput[], spentBy: string): Promise<void> => {
        const plain = inputs.filter((i) => !tokenKeys.has(`${i.outpoint.txid}:${i.outpoint.vout}`)).map((i) => i.outpoint);
        await rpc.call("lockunspent", [false, plain]);
        await locked.reserve(plain.map((o) => `${o.txid}:${o.vout}`), holdOf(req, spentBy, holdMs));
      };
      if (req.asset === ASSET_YED) {
        const free = tokenRows.filter((r) => !reserved.has(`${r.txid}:${r.vout}`));
        return fundYed(rpc, req, free, coins, changeScript, lock, async (outpoints, spentBy) => {
          await reservations.reserve(outpoints, holdOf(req, spentBy, holdMs));
        });
      }
      const picked: FundingInput[] = [];
      for (const c of coins) {
        picked.push(c);
        try {
          const tx = buildFundingTx({ inputs: picked, redeemScript: req.redeemScript, value: req.value, changeScript, expiryHeight: req.expiryHeight ?? 0 });
          const signed = await rpc.signRawTransactionWithWallet(serializeTxHex(tx));
          if (!signed.complete) throw new Error(`the wallet could not sign the funding inputs: ${JSON.stringify(signed.errors)}`);
          await lock(picked, txidOf(hexToBytes(signed.hex)));
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
  lock: (inputs: readonly FundingInput[], spentBy: string) => Promise<void>,
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
    expiryHeight: req.expiryHeight ?? 0,
  });
  const signed = await rpc.signRawTransactionWithWallet(serializeTxHex(built.tx));
  if (!signed.complete) throw new Error(`the wallet could not sign the funding inputs: ${JSON.stringify(signed.errors)}`);
  const spentBy = txidOf(hexToBytes(signed.hex));
  await lock(built.inputs, spentBy);
  await reserve(sel.coins.map((t) => `${t.outpoint.txid}:${t.outpoint.vout}`), spentBy);
  return signed.hex;
}

/** The address of a P2PKH or P2SH script (a funder's change script as its return address). */
function addressOfScript(network: YcashNetwork, script: Uint8Array): string {
  const pkh = p2pkhHash(script);
  if (pkh) return encodeAddress(network, "p2pkh", pkh);
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return encodeAddress(network, "p2sh", script.slice(2, 22));
  throw new Error("the change script is neither P2PKH nor P2SH");
}

/** Funds a YEC channel from known coins with local keys; `privKeys[i]` owns `coins[i]`. The remainder returns to the change script. */
export function localKeyFunder(coins: readonly FundingInput[], privKeys: readonly Uint8Array[], changeScript: Uint8Array): ChannelFunder {
  return {
    async returnAddress(req) {
      return addressOfScript(req.network, changeScript);
    },
    async fund(req) {
      if (req.asset === ASSET_YED) throw new Error("localKeyFunder funds YEC channels; a YED channel needs localKeyYedFunder, utxoSourceFunder or rpcWalletFunder");
      const tx = buildFundingTx({ inputs: coins, redeemScript: req.redeemScript, value: req.value, changeScript, expiryHeight: req.expiryHeight ?? 0 });
      return serializeTxHex(signFundingTx(tx, coins, privKeys, req.branchId));
    },
  };
}

/** Where `utxoSourceFunder` lists the key's coins (exact's RpcUtxoSource fits). */
export interface FundingCoinSource {
  listCoins(address: string): Promise<{ txid: string; vout: number; value: bigint; scriptPubKey: Uint8Array }[]>;
  /** As UtxoSource.reserve: holds the funding's coins until its expiry height; false = select again. */
  reserve?(coins: readonly { txid: string; vout: number }[], spend: { txid: string; expiryHeight: number }): Promise<boolean>;
  /** As UtxoSource.listTokens: the key's YED outputs (token records). Needed for YED channels. */
  listTokens?(address: string): Promise<TokenCoin[]>;
}

const byValueDesc = <T extends { value: bigint }>(a: T, b: T): number => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0);

/**
 * Funds from one local P2PKH key's coins as a UtxoSource lists them, change and the channel's
 * remainder back to the key. The localKeyFunder for an agent that holds a WIF and reads its coins
 * from a node or a light client. YEC: the largest coins until they cover V and the fee. YED: the
 * key's token outputs over D (`listTokens`) and its plain coins for V and the fee, in a TRANSFER
 * that returns the YED change to the key. The coins of a signed funding are held, in the source's
 * reservations and in this funder, until the funding's expiry height, since the server, not the
 * funder, broadcasts it.
 */
export function utxoSourceFunder(privKey: Uint8Array, source: FundingCoinSource, compressed = true): ChannelFunder {
  const pub = pubkeyFromPriv(privKey, compressed);
  const script = p2pkhScript(hash160(pub));
  /** outpoint → the expiry height of the funding that spent it (0: never expires). */
  const used = new Map<string, number>();
  const free = (req: FundingRequest, o: { txid: string; vout: number }): boolean => {
    const exp = used.get(`${o.txid}:${o.vout}`);
    return exp === undefined || (exp > 0 && req.tip !== undefined && req.tip > exp);
  };
  /** Holds the signed funding's inputs; false when another spend took one of them meanwhile. */
  const hold = async (req: FundingRequest, hex: string): Promise<boolean> => {
    const signed = parseTx(hex);
    const outpoints = signed.vin.map((i) => i.prevout);
    const expiryHeight = req.expiryHeight ?? 0;
    if (source.reserve && !(await source.reserve(outpoints, { txid: txidOf(signed), expiryHeight }))) return false;
    for (const o of outpoints) used.set(`${o.txid}:${o.vout}`, expiryHeight);
    return true;
  };
  const yecCoins = async (req: FundingRequest, address: string): Promise<FundingInput[]> =>
    (await source.listCoins(address))
      .filter((c) => equalBytes(c.scriptPubKey, script) && free(req, c))
      .sort(byValueDesc)
      .map((c) => ({ outpoint: { txid: c.txid, vout: c.vout }, value: c.value, scriptPubKey: c.scriptPubKey }));
  /** One selection; undefined when another spend took one of the picked coins meanwhile. */
  const fundYecOnce = async (req: FundingRequest, address: string): Promise<string | undefined> => {
    const coins = await yecCoins(req, address);
    for (let n = 1; n <= coins.length; n++) {
      const picked = coins.slice(0, n);
      let hex: string;
      try {
        hex = await localKeyFunder(picked, picked.map(() => privKey), script).fund(req);
      } catch (e) {
        if (/cannot pay/.test((e as Error).message)) continue;
        throw e;
      }
      return (await hold(req, hex)) ? hex : undefined;
    }
    throw new Error(`the coins of ${address} cannot fund ${req.value} zatoshis`);
  };
  const fundYedOnce = async (req: FundingRequest, address: string): Promise<string | undefined> => {
    if (!source.listTokens) throw new Error("this coin source cannot list YED outputs (listTokens), so it cannot fund a YED channel");
    const tokens = (await source.listTokens(address)).filter((t) => equalBytes(t.scriptPubKey, script) && free(req, t.outpoint));
    // YED and YEC change both return to the key (its ye… and s… forms share the script).
    const hex = await localKeyYedFunder(tokens, await yecCoins(req, address), () => privKey, { yed: script, yec: script }).fund(req);
    return (await hold(req, hex)) ? hex : undefined;
  };
  return {
    async returnAddress(req) {
      return encodeAddress(req.network, req.asset === ASSET_YED ? "yed" : "p2pkh", hash160(pub));
    },
    async fund(req) {
      const address = encodeAddress(req.network, "p2pkh", hash160(pub));
      for (let attempt = 1; attempt <= 3; attempt++) {
        const hex = req.asset === ASSET_YED ? await fundYedOnce(req, address) : await fundYecOnce(req, address);
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
    async returnAddress(req) {
      return addressOfScript(req.network, change.yed);
    },
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
        expiryHeight: req.expiryHeight ?? 0,
      });
      return serializeTxHex(signFundingTx(built.tx, built.inputs, built.inputs.map((i) => keyOf(i.outpoint)), req.branchId));
    },
  };
}
