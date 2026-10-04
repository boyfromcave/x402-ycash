// A local-key client's coins through lightwalletd instead of a node: the light-client UtxoSource
// (plan C-1, X5). Coins come from GetAddressUtxos, YED outputs from GetAddressTokens, the tip and
// branch id from GetLightdInfo.
//
// The mempool-spend guard is weaker than RpcUtxoSource's: both lightwalletd listings read the
// node's indexes (`getaddressutxos`, `yed_listtokens`), which hold confirmed outputs and are not
// updated by mempool spends, and GetMempoolTx sends Sapling transactions only. So a coin spent by a
// transaction still in the mempool keeps being listed until a block confirms the spend. This source
// leans on the reservation store instead: every spend this payer signs holds its coins until the
// spend's expiry height, by when it is either mined (the coin leaves the index) or dropped. A spend
// of the same key from elsewhere (another wallet, another reservation file) is not seen; its
// conflict surfaces as the facilitator's or server's broadcast refusal.
import { heldOutpoints, InMemoryCoinReservationStore, type CoinReservationStore } from "../store/coinReservations.js";
import { addressToScript, type OutPoint } from "../tx/index.js";
import type { TokenCoin } from "../yed/index.js";
import type { Coin } from "../exact/client/coinSelection.js";
import type { ChainState } from "../exact/client/signer.js";
import type { UtxoSource } from "../exact/client/utxoSource.js";
import { LwdChain } from "./chain.js";
import { LwdError, type LwdClient } from "./client.js";

export interface LwdUtxoSourceOptions {
  /** Where coins of signed, unconfirmed spends are held (shared across processes with a file store). */
  reservations?: CoinReservationStore;
  /** How long a spend that never expires holds its coins (default 30 min). */
  noExpiryHoldMs?: number;
}

const key = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;

export class LwdUtxoSource implements UtxoSource {
  readonly chain: LwdChain;
  private readonly reservations: CoinReservationStore;

  constructor(
    readonly lwd: LwdClient,
    private readonly options: LwdUtxoSourceOptions = {},
  ) {
    this.chain = new LwdChain(lwd);
    this.reservations = options.reservations ?? new InMemoryCoinReservationStore();
  }

  chainState(): Promise<ChainState> {
    return this.chain.chainState();
  }

  /**
   * The address's confirmed coins, less those holding YED (a YEC payment must not spend them, rule
   * 9Y) and those held by this payer's unconfirmed spends. Without the YellowbackStreamer (a server
   * started without `--yellowback`) token outputs cannot be told apart, as on a stock node.
   */
  async listCoins(address: string): Promise<Coin[]> {
    const [state, utxos, tokens] = await Promise.all([this.chainState(), this.lwd.getAddressUtxos([address]), this.tokenOutpoints(address)]);
    const held = await heldOutpoints(this.reservations, state.height);
    return utxos
      .filter((u) => !tokens.has(key(u)) && !held.has(key(u)))
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubKey: u.scriptPubKey, confirmations: Math.max(1, state.height - u.height + 1) }));
  }

  async reserve(coins: readonly OutPoint[], spend: { txid: string; expiryHeight: number }): Promise<boolean> {
    return this.reservations.reserve(coins.map(key), {
      spentBy: spend.txid,
      expiryHeight: spend.expiryHeight,
      ...(spend.expiryHeight === 0 ? { untilMs: Date.now() + (this.options.noExpiryHoldMs ?? 1_800_000) } : {}),
    });
  }

  /** The address's YED outputs (`yed_listtokens` through GetAddressTokens), less those held. */
  async listTokens(address: string): Promise<TokenCoin[]> {
    const [state, rows] = await Promise.all([this.chainState(), this.lwd.getAddressTokens([address])]);
    const held = await heldOutpoints(this.reservations, state.height);
    return rows
      .filter((r) => !held.has(key(r)))
      .map((r) => ({ outpoint: { txid: r.txid, vout: r.vout }, cents: Number(r.cents), value: BigInt(r.valueZat), scriptPubKey: addressToScript(r.transparentAddress || r.address) }));
  }

  private async tokenOutpoints(address: string): Promise<Set<string>> {
    try {
      return new Set((await this.lwd.getAddressTokens([address])).map(key));
    } catch (e) {
      if (e instanceof LwdError && e.unimplemented) return new Set();
      throw e;
    }
  }
}
