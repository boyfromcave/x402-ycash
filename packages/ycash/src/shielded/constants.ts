// `sapling-proof`: the client-submitted shielded YEC method of `exact` (specs/scheme_exact_ycash.md,
// "sapling-proof"; plan §5.9 X4a).
import { YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../constants.js";

export const SCHEME_EXACT = "exact" as const;
export const ASSET_TRANSFER_METHOD_SAPLING_PROOF = "sapling-proof" as const;
/** The facilitator-submitted shielded method (spec, "sapling"; plan X4b), implemented in saplingFacilitator.ts. */
export const ASSET_TRANSFER_METHOD_SAPLING = "sapling" as const;
export const PAYMENT_FLOW_UPFRONT = "upfront" as const;

/** `extra.memo` is this prefix and the 64-hex request hash. */
export const MEMO_PREFIX = "x402:";
export const MEMO_REGEX = /^x402:[0-9a-f]{64}$/;
export const TXID_REGEX = /^[0-9a-f]{64}$/;

/** `sapling-proof` defaults to one confirmation (spec, "Confirmation policy"). */
export const DEFAULT_SAPLING_PROOF_CONFIRMATIONS = 1;
export const MIN_CONFIRMATIONS = -1;
export const MAX_CONFIRMATIONS = 20;

/** The receipt's `payer`: the method does not identify payers (spec, "Receipts"). */
export const ANONYMOUS_PAYER = "anonymous";

/** The `offer-and-receipt` extension key. */
export const OFFER_RECEIPT = "offer-receipt";

/** Sapling address HRPs per network (`chainparams.cpp`, plan G-2). */
export const SAPLING_HRP: Readonly<Record<YcashNetwork, string>> = {
  [YCASH_MAINNET]: "ys",
  [YCASH_TESTNET]: "ytestsapling",
  [YCASH_REGTEST]: "yregtestsapling",
};

/** `getblockchaininfo.chain` per network id (spec, "Network Identifiers"). */
export const CHAIN_OF: Readonly<Record<YcashNetwork, string>> = {
  [YCASH_MAINNET]: "main",
  [YCASH_TESTNET]: "test",
  [YCASH_REGTEST]: "regtest",
};

/** Error codes the method returns (spec, "Error Codes"), plus the core codes it uses. */
export const ERR = {
  requirementsMismatch: "invalid_exact_ycash_requirements_mismatch",
  assetTransferMethod: "invalid_exact_ycash_asset_transfer_method",
  paymentFlow: "invalid_exact_ycash_payment_flow",
  unknownInstrument: "invalid_exact_ycash_unknown_instrument",
  txidMalformed: "invalid_exact_ycash_txid_malformed",
  notReceived: "invalid_exact_ycash_not_received",
  memoMismatch: "invalid_exact_ycash_memo_mismatch",
  underpaid: "invalid_exact_ycash_underpaid",
  networkMismatch: "network_mismatch",
  settlementPending: "settlement_pending",
  duplicateSettlement: "duplicate_settlement",
  unexpected: "unexpected_settle_error",
} as const;
export type ShieldedErrorReason = (typeof ERR)[keyof typeof ERR];
