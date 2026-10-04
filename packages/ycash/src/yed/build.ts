// Building a TRANSFER that never burns: token coin selection under the dollar floor, YEC coins for
// the outputs' value and the fee, and the unsigned v4 transaction with its payload. Shared by the
// YED `exact` client (specs/scheme_exact_ycash.md, "Transaction Construction", YED) and the YED
// channel's funding transaction (specs/scheme_batch_settlement_ycash.md, "YED Channels").
//
// The node's own wallet builder is the model (ycash-dd/src/yellowback/txbuilder.cpp:365-370, same on
// ycash6): token inputs confirmed only, each YED output carrying TOKEN_VALUE (params.h:78), every
// cent of yedIn assigned.
import { TOKEN_VALUE_ZAT, YED_MAX_OUTPUT_CENTS, YED_MIN_OUTPUT_CENTS } from "../constants.js";
import { feeFloor } from "../tx/fee.js";
import { SEQUENCE_FINAL, newTx, type OutPoint, type Tx, type TxOut } from "../tx/tx.js";
import type { Assignment } from "./payload.js";
import { transferOpReturnScript } from "./script.js";
import { validateTransferAssignments } from "./transfer.js";

/** YEC on a wallet-built YED output (Y-12). */
export const TOKEN_VALUE = BigInt(TOKEN_VALUE_ZAT);
/** Dust threshold of a P2PKH output at the default relay fee (plan S-5, X-F15). */
const DUST = 54n;
/** A P2PKH scriptSig at its largest: push(72-byte DER + hash type) + push(33-byte key). */
const MAX_P2PKH_SCRIPTSIG = 1 + 73 + 1 + 33;

/** A confirmed output holding YED (a token record: `yed_listtokens`, `yed_listunspent`). */
export interface TokenCoin {
  outpoint: OutPoint;
  cents: number;
  /** The output's YEC value, zatoshis. */
  value: bigint;
  scriptPubKey: Uint8Array;
}

/** A confirmed plain-YEC output (no token record). */
export interface YecCoin {
  outpoint: OutPoint;
  value: bigint;
  scriptPubKey: Uint8Array;
}

export interface TokenSelection {
  coins: TokenCoin[];
  /** yedIn − amount: 0, or in [100, 10,000,000]. */
  changeCents: number;
}

const sum = (cs: readonly TokenCoin[]) => cs.reduce((s, c) => s + c.cents, 0);
const validChange = (c: number) => c === 0 || (c >= YED_MIN_OUTPUT_CENTS && c <= YED_MAX_OUTPUT_CENTS);

/**
 * Token coins for `amountCents` such that the change is 0 or a valid YED output (XFER-1): a change
 * in (0, $1.00) would make the whole TRANSFER burn. An exact single coin first, then largest-first;
 * a sub-dollar change is cured by one more coin (every token record holds at least $1.00, so the
 * change then clears the floor). Throws rather than return a burning selection.
 */
export function selectTokenCoins(tokens: readonly TokenCoin[], amountCents: number): TokenSelection {
  if (!Number.isInteger(amountCents) || amountCents < YED_MIN_OUTPUT_CENTS || amountCents > YED_MAX_OUTPUT_CENTS) {
    throw new RangeError(`a YED amount must be ${YED_MIN_OUTPUT_CENTS}..${YED_MAX_OUTPUT_CENTS} cents: ${amountCents}`);
  }
  const exact = tokens.find((t) => t.cents === amountCents);
  if (exact) return { coins: [exact], changeCents: 0 };
  const sorted = [...tokens].sort((a, b) => b.cents - a.cents);
  const picked: TokenCoin[] = [];
  for (let i = 0; i < sorted.length; i++) {
    picked.push(sorted[i] as TokenCoin);
    const change = sum(picked) - amountCents;
    if (change < 0) continue;
    if (validChange(change)) return { coins: picked, changeCents: change };
    if (change > 0 && change < YED_MIN_OUTPUT_CENTS) {
      // One more coin, the smallest left, lifts the change over $1.00.
      const rest = sorted.slice(i + 1);
      const extra = rest[rest.length - 1];
      if (extra) {
        const c = change + extra.cents;
        if (validChange(c)) return { coins: [...picked, extra], changeCents: c };
      }
    }
    break;
  }
  const total = sum(tokens);
  throw new Error(
    total < amountCents
      ? `insufficient YED: ${total} cents in ${tokens.length} confirmed token outputs, need ${amountCents}`
      : `no selection of ${tokens.length} token outputs pays ${amountCents} cents without a change below $1.00 (it would burn)`,
  );
}

/** One assigned output of the transfer. */
export interface TransferRecipient {
  scriptPubKey: Uint8Array;
  cents: number;
  /** YEC on the output; default TOKEN_VALUE. */
  value?: bigint;
}

export interface BuildYedTransferParams {
  /** Assigned outputs, at vouts 0..n−1 in this order. */
  recipients: readonly TransferRecipient[];
  /** Token inputs (from selectTokenCoins); their cents minus the recipients' is the YED change. */
  tokens: readonly TokenCoin[];
  /** Plain-YEC candidates for the outputs' YEC and the fee, used largest-first as needed. */
  yecCoins: readonly YecCoin[];
  /** Where the YED change goes (a P2PKH, the payer's `ye…` key hash). */
  yedChangeScript: Uint8Array;
  /** Where YEC change goes. */
  yecChangeScript: Uint8Array;
  expiryHeight?: number;
}

export interface BuiltYedTransfer {
  /** Unsigned: every scriptSig empty. Token inputs first, then YEC inputs. */
  tx: Tx;
  /** The coin each vin spends, in vin order (value and script for the sighash). */
  inputs: YecCoin[];
  assignments: Assignment[];
  opReturnIndex: number;
  changeCents: number;
  fee: bigint;
}

/**
 * The TRANSFER: recipients at vouts 0..n−1, the YED change (if any) next, then the OP_RETURN, then
 * YEC change (if not dust). Every cent of yedIn is assigned, so nothing burns; the fee is the S-6
 * floor of the tx with signatures at their largest. Throws when the coins cannot pay.
 */
export function buildYedTransfer(p: BuildYedTransferParams): BuiltYedTransfer {
  if (p.recipients.length === 0) throw new Error("a transfer needs a recipient");
  const yedIn = sum(p.tokens);
  const paid = p.recipients.reduce((s, r) => s + r.cents, 0);
  const changeCents = yedIn - paid;
  if (!validChange(changeCents)) throw new Error(`YED change ${changeCents} cents would burn (it must be 0 or ${YED_MIN_OUTPUT_CENTS}..${YED_MAX_OUTPUT_CENTS})`);

  const assigned: TxOut[] = p.recipients.map((r) => ({ value: r.value ?? TOKEN_VALUE, scriptPubKey: r.scriptPubKey }));
  const assignments: Assignment[] = p.recipients.map((r, vout) => ({ vout, cents: r.cents }));
  if (changeCents > 0) {
    assignments.push({ vout: assigned.length, cents: changeCents });
    assigned.push({ value: TOKEN_VALUE, scriptPubKey: p.yedChangeScript });
  }
  const opReturnIndex = assigned.length;
  const opReturn: TxOut = { value: 0n, scriptPubKey: transferOpReturnScript(assignments) };
  const check = validateTransferAssignments(assignments, assigned.length + 1, opReturnIndex, { yedInCents: yedIn });
  if (!check.valid) throw new Error(`the transfer would burn: ${check.error}`);

  const tokenInputs: YecCoin[] = p.tokens.map((t) => ({ outpoint: t.outpoint, value: t.value, scriptPubKey: t.scriptPubKey }));
  const outValue = assigned.reduce((s, o) => s + o.value, 0n);
  const yec = [...p.yecCoins].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const draft = (inputs: readonly YecCoin[], vout: TxOut[]): Tx =>
    newTx({
      vin: inputs.map((c) => ({ prevout: c.outpoint, scriptSig: new Uint8Array(MAX_P2PKH_SCRIPTSIG), sequence: SEQUENCE_FINAL })),
      vout,
      expiryHeight: p.expiryHeight ?? 0,
    });
  for (let n = 0; n <= yec.length; n++) {
    const inputs = [...tokenInputs, ...yec.slice(0, n)];
    const total = inputs.reduce((s, c) => s + c.value, 0n);
    const withChange = [...assigned, opReturn, { value: 1n, scriptPubKey: p.yecChangeScript }];
    const feeWith = feeFloor(draft(inputs, withChange));
    let vout: TxOut[] | undefined;
    let fee = 0n;
    if (total >= outValue + feeWith + DUST) {
      fee = feeWith;
      vout = [...assigned, opReturn, { value: total - outValue - feeWith, scriptPubKey: p.yecChangeScript }];
    } else {
      const feeAlone = feeFloor(draft(inputs, [...assigned, opReturn]));
      if (total >= outValue + feeAlone) {
        fee = total - outValue; // a sub-dust remainder pays the fee
        vout = [...assigned, opReturn];
      }
    }
    if (vout) {
      const tx = draft(inputs, vout);
      for (const i of tx.vin) i.scriptSig = new Uint8Array();
      return { tx, inputs, assignments, opReturnIndex, changeCents, fee };
    }
  }
  const have = [...tokenInputs, ...yec].reduce((s, c) => s + c.value, 0n);
  throw new Error(`insufficient YEC: ${have} zatoshis cannot pay ${outValue} for the YED outputs plus the fee`);
}
