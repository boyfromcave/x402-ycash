// Where the Ycash client-side schemes plug into the agent. One `client.register` call per scheme.
import type { x402Client } from "@x402/fetch";
import type { YcashNetwork } from "x402-ycash-mechanism";
import type { AgentSigner } from "./config.js";

export interface ClientSchemeDeps {
  network: YcashNetwork;
  signer: AgentSigner;
}

export type RegisterClientSchemes = (client: x402Client, deps: ClientSchemeDeps) => string[];

export const registerClientSchemes: RegisterClientSchemes = (client, deps) => {
  const registered: string[] = [];
  void client;
  void deps;

  // ── SLOT 1: exact (transparent YEC; the client signs a complete v4 tx and does not broadcast) ──
  //   const signer = deps.signer.kind === "wif"
  //     ? new LocalYcashSigner(deps.signer.privKey, rpcForUtxos)   // x402-ycash-mechanism exact/client
  //     : new RpcYcashSigner(deps.signer.rpc);
  //   client.register(deps.network, new ExactYcashScheme(signer));
  //   registered.push("exact");

  // ── SLOT 2: batch-settlement (open a channel once, then one voucher per request) ──────────────
  //   client.register(deps.network, new BatchSettlementYcashScheme(signer, { channelStore }));
  //   registered.push("batch-settlement");

  // ── SLOT 3: exact, sapling-proof (pay the per-request ys1… with z_sendmany, present the txid) ──
  //   needs deps.signer.kind === "node" (a shielded wallet); served by the SLOT 1 scheme.

  return registered;
};
