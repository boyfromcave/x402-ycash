// Coin selection and fee for a one-payment transaction (Transaction Construction: one output of
// exactly `amount` to payTo, change, fee ≥ the S-6 floor).
import { feeFloor, newTx, SEQUENCE_FINAL, type Tx, type TxOut } from "../../tx/index.js";
import { DUST_ZAT } from "../policy.js";

export interface Coin {
  txid: string;
  vout: number;
  /** zatoshis */
  value: bigint;
  scriptPubKey: Uint8Array;
  confirmations: number;
}

export interface Selection {
  coins: Coin[];
  fee: bigint;
  /** 0n when the remainder was below dust and went to the fee. */
  change: bigint;
}

/** A P2PKH scriptSig at its largest: push(72-byte DER + hash type) + push(33-byte key). */
const MAX_P2PKH_SCRIPTSIG = 1 + 73 + 1 + 33;

/** The fee floor of a draft with `n` P2PKH inputs and the given outputs, signatures at their largest. */
export function draftFee(n: number, outputs: TxOut[]): bigint {
  const draft: Tx = newTx({
    vin: Array.from({ length: n }, (_, i) => ({ prevout: { txid: "00".repeat(32), vout: i }, scriptSig: new Uint8Array(MAX_P2PKH_SCRIPTSIG), sequence: SEQUENCE_FINAL })),
    vout: outputs,
  });
  return feeFloor(draft);
}

/**
 * Largest-first over confirmed coins until amount + fee is covered. The fee is the floor of the
 * draft with signatures at their largest, so the signed tx's own floor never exceeds it.
 */
export function selectCoins(candidates: readonly Coin[], amount: bigint, payToScript: Uint8Array, changeScript: Uint8Array): Selection {
  const coins = candidates.filter((c) => c.confirmations >= 1).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const picked: Coin[] = [];
  let total = 0n;
  for (const c of coins) {
    picked.push(c);
    total += c.value;
    const withChange = draftFee(picked.length, [{ value: amount, scriptPubKey: payToScript }, { value: 1n, scriptPubKey: changeScript }]);
    if (total >= amount + withChange) {
      const change = total - amount - withChange;
      if (change >= DUST_ZAT) return { coins: picked, fee: withChange, change };
      return { coins: picked, fee: total - amount, change: 0n }; // sub-dust remainder pays the fee
    }
    const alone = draftFee(picked.length, [{ value: amount, scriptPubKey: payToScript }]);
    if (total >= amount + alone) return { coins: picked, fee: total - amount, change: 0n };
  }
  throw new Error(`insufficient funds: ${total} zatoshis in ${coins.length} confirmed coins, need ${amount} plus the fee`);
}
