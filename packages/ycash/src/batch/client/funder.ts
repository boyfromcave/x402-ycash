// Funding a channel. A funder returns the signed funding transaction paying V to the channel's
// P2SH script; it never broadcasts (the server relays it). Two funders: a node wallet over RPC, and
// local keys over known coins (channel/funding.ts).
import { buildFundingTx, signFundingTx, type FundingInput } from "../../channel/funding.js";
import { buildYedFundingTx, yedChannelValue } from "../../channel/yed.js";
import { ASSET_YED, type YcashNetwork } from "../../constants.js";
import { RPC_METHOD_NOT_FOUND, RpcError } from "../../node/errors.js";
import { selectTokenCoins, type TokenCoin } from "../../yed/build.js";
import type { YcashRpc } from "../../node/rpc.js";
import { yecToZat } from "../../node/amount.js";
import { addressToScript } from "../../tx/address.js";
import { hexToBytes } from "../../tx/bytes.js";
import { p2pkhHash } from "../../tx/script.js";
import { serializeTxHex } from "../../tx/tx.js";

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
export function rpcWalletFunder(rpc: FunderRpc): ChannelFunder {
  // YED outputs this funder signed away. The Yellowback wallet keeps all its YED outputs locked
  // against plain YEC spends (ycash-dd/src/yellowback/wallet.cpp:404-410), so a lock marks nothing.
  const reserved = new Set<string>();
  return {
    async fund(req) {
      const tokenRows = await walletTokens(rpc);
      const tokenKeys = new Set(tokenRows.map((r) => `${r.txid}:${r.vout}`));
      const coins = (await rpc.listUnspent(1))
        .filter((u) => u.spendable && !u.generated && p2pkhHash(hexToBytes(u.scriptPubKey)) !== null && !tokenKeys.has(`${u.txid}:${u.vout}`))
        .map((u) => ({ outpoint: { txid: u.txid, vout: u.vout }, value: yecToZat(u.amount), scriptPubKey: hexToBytes(u.scriptPubKey) }))
        .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
      const changeScript = addressToScript(await rpc.call<string>("getrawchangeaddress"), req.network);
      if (req.asset === ASSET_YED) return fundYed(rpc, req, tokenRows.filter((r) => !reserved.has(`${r.txid}:${r.vout}`)), coins, changeScript, reserved);
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
  reserved: Set<string>,
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
  for (const t of sel.coins) reserved.add(`${t.outpoint.txid}:${t.outpoint.vout}`);
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
