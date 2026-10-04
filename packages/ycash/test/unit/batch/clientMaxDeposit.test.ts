// The client's own deposit cap: spend controls cap only `amount`, and the server picks maxDeposit,
// so a client refuses to lock more than its maxDeposit in one channel.
import { describe, expect, it } from "vitest";
import { type batch, tx as T } from "../../../src/index.js";
import { DEFAULT_CLIENT_MAX_CLOSE_FEE, DEFAULT_CLIENT_MAX_DEPOSIT } from "../../../src/batch/client/index.js";
import { setup } from "./setup.js";

const DEFAULT_CLIENT_MAX_DEPOSIT_YEC = DEFAULT_CLIENT_MAX_DEPOSIT.YEC;

const depositOf = async (s: Awaited<ReturnType<typeof setup>>) => {
  const p = (await s.pay()).payload as unknown as batch.BatchOpenPayload;
  return T.parseTx(p.fundingTx).vout[p.vout]!.value - 1500n;
};

describe("client maxDeposit", () => {
  it("defaults to 1 YEC: a server allowing more does not raise it", async () => {
    expect(DEFAULT_CLIENT_MAX_DEPOSIT_YEC).toBe(100_000_000n);
    const s = await setup({ deposit: 100_000_001n, maxDeposit: 500_000_000n });
    await expect(s.pay()).rejects.toThrow(/above this client's maxDeposit 100000000 for YEC/);
  });

  it("caps the default deposit at a configured maxDeposit", async () => {
    const s = await setup({ clientMaxDeposit: 50_000n, clientDeposit: false }); // amount 2000 × 100 = 200,000
    expect(await depositOf(s)).toBe(50_000n);
  });

  it("refuses an explicit deposit above it, before funding anything", async () => {
    const s = await setup({ deposit: 100_000n, clientMaxDeposit: 99_999n });
    await expect(s.pay()).rejects.toThrow(/above this client's maxDeposit 99999/);
    expect(s.chain.sent).toHaveLength(0);
  });

  it("refuses a request whose amount alone exceeds it", async () => {
    const s = await setup({ amount: "60000", clientMaxDeposit: 50_000n, clientDeposit: false });
    await expect(s.pay()).rejects.toThrow(/cannot carry one request/);
  });
});

// The server also chooses closeFee, which is locked in V and paid to miners at close (plan X-F50).
describe("client maxCloseFee", () => {
  it("defaults to 5,000 zatoshis: a closeFee above it is refused before funding anything", async () => {
    expect(DEFAULT_CLIENT_MAX_CLOSE_FEE).toEqual({ YEC: 5_000n, YED: 5_000n });
    const ok = await setup({ closeFee: 5_000n });
    expect((await ok.pay()).payload.type).toBe("open");
    const s = await setup({ closeFee: 5_001n });
    await expect(s.pay()).rejects.toThrow(/closeFee 5001 is above this client's maxCloseFee 5000 for YEC/);
    expect(s.fundings).toHaveLength(0);
  });

  it("takes a configured cap", async () => {
    const s = await setup({ closeFee: 2_000n, clientMaxCloseFee: 1_999n });
    await expect(s.pay()).rejects.toThrow(/maxCloseFee 1999/);
    expect((await (await setup({ closeFee: 2_000n, clientMaxCloseFee: 2_000n })).pay()).payload.type).toBe("open");
  });
});
