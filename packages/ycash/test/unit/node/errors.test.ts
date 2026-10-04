import { describe, expect, it } from "vitest";
import { RpcError, SendRawTransactionError, classifySendError } from "../../../src/node/index.js";

describe("sendrawtransaction error kinds", () => {
  it("maps -27 to already-in-chain", () => {
    expect(classifySendError(-27, "transaction already in block chain")).toBe("already-in-chain");
  });
  it("maps both lines' mempool double spend to mempool-conflict", () => {
    expect(classifySendError(-26, "txn-mempool-conflict")).toBe("mempool-conflict"); // 6.21.0
    expect(classifySendError(-25, "")).toBe("mempool-conflict"); // v4.5.0: no reason set
  });
  it("maps missing inputs, expiry and other rejections", () => {
    expect(classifySendError(-25, "Missing inputs")).toBe("missing-inputs");
    expect(classifySendError(-26, "tx-expiring-soon: expiryheight is 5 but should be at least 8")).toBe("expiring-soon");
    expect(classifySendError(-26, "tx-overwinter-expired")).toBe("expiring-soon");
    expect(classifySendError(-26, "mandatory-script-verify-flag-failed")).toBe("rejected");
    expect(classifySendError(-4, "yed-burn-refused: …")).toBe("failed");
  });
  it("parses the reject code out of the message", () => {
    const e = new SendRawTransactionError(new RpcError(-26, "18: txn-mempool-conflict", "sendrawtransaction"));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.rejectCode).toBe(18);
    expect(e.rejectReason).toBe("txn-mempool-conflict");
    expect(e.kind).toBe("mempool-conflict");
    expect(e.code).toBe(-26);
    expect(e.method).toBe("sendrawtransaction");
  });
});
