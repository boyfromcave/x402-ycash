// The client's signer backends sit behind one interface, as Cardano's ClientCardanoSigner does.
import type { YcashNetwork } from "../../constants.js";
import type { OutPoint } from "../../tx/index.js";

/** What the client sees of the chain: the tip it counts expiry from, and the branch id it signs at. */
export interface ChainState {
  /** `getblockchaininfo.chain`: "main", "test" or "regtest". */
  chain: string;
  height: number;
  /** Consensus branch id of the next block (ZIP-243), e.g. 0x19bd2d2f (Canopy, X-F9). */
  branchId: number;
}

/** One payment to build: exactly `amount` to `payTo`, valid through `expiryHeight`. */
export interface PaymentOrder {
  network: YcashNetwork;
  payTo: string;
  /** zatoshis */
  amount: bigint;
  expiryHeight: number;
  /** The tip the expiry was counted from. */
  tip: number;
  /** The branch id read with the tip; signatures commit to it. */
  branchId: number;
}

export interface SignedPayment {
  /** The complete signed v4 tx, lowercase hex. Never broadcast by the signer. */
  hex: string;
  txid: string;
  inputs: OutPoint[];
}

export interface YcashClientSigner {
  chainState(): Promise<ChainState>;
  /** Selects coins, builds and signs (SIGHASH_ALL, nLockTime 0); never broadcasts. */
  signPayment(order: PaymentOrder): Promise<SignedPayment>;
}

/** `getblockchaininfo` → ChainState. */
export function chainStateOf(info: { chain: string; blocks: number; consensus: { nextblock: string } }): ChainState {
  return { chain: info.chain, height: info.blocks, branchId: parseInt(info.consensus.nextblock, 16) >>> 0 };
}
