// FakeChain with the Yellowback overlay: token records that move when a block confirms a TRANSFER,
// and the two RPCs a YED channel reads, modelled on ApplyTransfer and IN-3
// (ycash-dd/src/yellowback/state.cpp:443-474, 860-885) and yed_validaterawtransaction's view of
// confirmed records only (src/rpc/yellowback.cpp:1429-1488).
import { tx as T, yed } from "../../../src/index.js";
import { RpcError } from "../../../src/node/index.js";
import type { YedPayload, YedValidation } from "../../../src/node/types.js";
import { FakeChain } from "./fakeChain.js";

export class FakeYedChain extends FakeChain {
  /** outpoint → cents, for confirmed outputs only */
  readonly tokens = new Map<string, number>();
  /** Overrides yed_decodepayload (a disagreeing node). */
  decodeOverride: YedPayload | undefined;
  /** Answers the overlay's RPCs with −32601, as a stock node does. */
  stock = false;
  private readonly applied = new Set<string>();

  addToken(txid: string, vout: number, cents: number, spk: Uint8Array): void {
    this.addCoin(txid, vout, 10_000n, spk);
    this.tokens.set(`${txid}:${vout}`, cents);
  }

  override mine(n = 1): void {
    const pending = this.sent.filter((hex) => !this.applied.has(T.txid(hex)));
    super.mine(n);
    for (const hex of pending) {
      this.applied.add(T.txid(hex));
      const tx = T.parseTx(hex);
      const r = this.evaluate(tx);
      for (const i of tx.vin) this.tokens.delete(`${i.prevout.txid}:${i.prevout.vout}`);
      if (r.verdict === "ok" || r.verdict === "burned") for (const a of r.assignments) this.tokens.set(`${T.txid(tx)}:${a.vout}`, a.cents);
    }
  }

  private evaluate(tx: T.Tx): { yedIn: number; yedOut: number; verdict: string; type: string; assignments: yed.Assignment[] } {
    const yedIn = tx.vin.reduce((s, i) => s + (this.tokens.get(`${i.prevout.txid}:${i.prevout.vout}`) ?? 0), 0);
    const found = yed.findPayload(tx.vout);
    if (!found || yed.isFindPayloadFailure(found) || found.payload.type !== "transfer") {
      return { yedIn, yedOut: 0, verdict: yedIn > 0 ? "burned" : "ok", type: "none", assignments: [] };
    }
    const as = [...found.payload.assignments];
    const total = as.reduce((s, a) => s + a.cents, 0);
    if (as.some((a) => a.cents < 100 || a.cents > 10_000_000)) return { yedIn, yedOut: 0, verdict: "bad-transfer-assignment", type: "transfer", assignments: [] };
    if (total > yedIn) return { yedIn, yedOut: 0, verdict: "transfer-over-assigned", type: "transfer", assignments: [] };
    if (yedIn <= 0) return { yedIn, yedOut: 0, verdict: "transfer-no-yed-input", type: "transfer", assignments: [] };
    return { yedIn, yedOut: total, verdict: total < yedIn ? "burned" : "ok", type: "transfer", assignments: as };
  }

  async yedValidateRawTransaction(hex: string): Promise<YedValidation> {
    if (this.stock) throw new RpcError(-32601, "Method not found", "yed_validaterawtransaction");
    const tx = T.parseTx(hex);
    const r = this.evaluate(tx);
    const unconfirmedInputs = tx.vin
      .filter((i) => (this.getTxOutSync(i.prevout.txid, i.prevout.vout)?.height ?? null) === null)
      .map((i) => ({ txid: i.prevout.txid, vout: i.prevout.vout }));
    return {
      valid: (await this.verifyScripts(hex)).complete, verdict: r.verdict, type: r.type, path: "", yedIn: r.yedIn, yedOut: r.yedOut, burned: r.yedIn - r.yedOut,
      feeZat: 0, payee: null, blockValid: true, wouldBeRejected: false, mempoolExpiryOk: true, unconfirmedInputs,
    };
  }

  async yedDecodePayload(hex: string): Promise<YedPayload> {
    if (this.stock) throw new RpcError(-32601, "Method not found", "yed_decodepayload");
    if (this.decodeOverride) return this.decodeOverride;
    const found = yed.findPayload(T.parseTx(hex).vout);
    if (!found || yed.isFindPayloadFailure(found)) return { valid: false, version: 0, type: "none", reason: "malformed" };
    const p = found.payload;
    return { valid: true, version: 3, type: p.type, reason: "", opReturnIndex: found.index, ...(p.type === "transfer" ? { assignments: p.assignments.map((a) => ({ ...a })) } : {}) };
  }

  private getTxOutSync(txid: string, vout: number): { height: number | null } | undefined {
    return this.coins.get(`${txid}:${vout}`);
  }
}
