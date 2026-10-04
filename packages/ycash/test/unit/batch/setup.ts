import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { batch, channel, tx as T, BatchYcashClientScheme, BatchYcashServerScheme, type ChannelStore } from "../../../src/index.js";
import { FakeChain } from "./fakeChain.js";

export const NET = "ycash:regtest" as const;
export const serverPriv = T.hexToBytes("44".repeat(32));
export const payToAddr = T.encodeAddress(NET, "p2pkh", T.hexToBytes("aa".repeat(20)));
const coinKey = T.hexToBytes("33".repeat(32));
const coinSpk = T.p2pkhScript(T.hash160(T.pubkeyFromPriv(coinKey)));

export interface Setup {
  chain: FakeChain;
  server: BatchYcashServerScheme;
  client: BatchYcashClientScheme;
  req: PaymentRequirements;
  /** the next payload of the client for `r` (default req), wrapped as core does */
  pay(r?: PaymentRequirements): Promise<PaymentPayload>;
  wrap(payload: Record<string, unknown>, r?: PaymentRequirements): PaymentPayload;
  /** verify then settle at `charge` (default the ceiling) */
  request(charge?: bigint, r?: PaymentRequirements): Promise<{ payload: PaymentPayload; settle: Awaited<ReturnType<BatchYcashServerScheme["manager"]["settle"]>> }>;
  closes: { channelId: string; reason: string; txid: string | undefined; cumulative: bigint }[];
}

export async function setup(o: { confirmations?: number; maxDeposit?: bigint; deposit?: bigint; idleMs?: number; amount?: string; store?: ChannelStore; slack?: number } = {}): Promise<Setup> {
  const chain = new FakeChain();
  const closes: Setup["closes"] = [];
  const server = new BatchYcashServerScheme({
    chain, serverPrivKey: serverPriv, maxDeposit: o.maxDeposit ?? 1_000_000n, confirmations: o.confirmations ?? 1,
    minLockBlocks: 100, closeMarginBlocks: 10, idleMs: o.idleMs ?? 600_000, ...(o.store ? { store: o.store } : {}),
    onClose: (e) => closes.push(e),
  });
  const base: PaymentRequirements = { scheme: "batch-settlement", network: NET, asset: "YEC", amount: o.amount ?? "2000", payTo: payToAddr, maxTimeoutSeconds: 300, extra: {} };
  const req = await server.enhancePaymentRequirements(base, { x402Version: 2, scheme: "batch-settlement", network: NET }, []);
  let n = 0;
  const funder: batch.client.ChannelFunder = {
    async fund(fr) {
      const txid = (++n).toString(16).padStart(64, "e");
      chain.addCoin(txid, 0, 10_000_000n, coinSpk);
      const coin = { outpoint: { txid, vout: 0 }, value: 10_000_000n, scriptPubKey: coinSpk };
      const tx = channel.buildFundingTx({ inputs: [coin], redeemScript: fr.redeemScript, value: fr.value, changeScript: coinSpk });
      return T.serializeTxHex(channel.signFundingTx(tx, [coin], [coinKey], fr.branchId));
    },
  };
  const client = new BatchYcashClientScheme({ chain, funder, deposit: () => o.deposit ?? 100_000n, lockSlackBlocks: o.slack ?? 0 });
  const wrap = (payload: Record<string, unknown>, r = req): PaymentPayload => ({ x402Version: 2, accepted: r, payload });
  const pay = async (r = req) => wrap((await client.createPaymentPayload(2, r)).payload, r);
  const request = async (charge?: bigint, r = req) => {
    const payload = await pay(r);
    const v = await server.manager.verify(payload, r);
    const settle = await server.manager.settle(v, charge ?? BigInt(r.amount));
    await client.applySettleResponse(settle);
    return { payload, settle };
  };
  return { chain, server, client, req, pay, wrap, request, closes };
}

/** The reason of a refused promise. */
export async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { reason?: string }).reason ?? (e as Error).message;
  }
  return "accepted";
}
