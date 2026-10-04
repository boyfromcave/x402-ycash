// Result shapes of the ycashd RPCs the SDK reads. Only the fields the SDK uses are typed; both
// lines return more (6.21.0's decoderawtransaction adds `authdigest`, plan §6.2), which is ignored.

export type NodeLine = "v4" | "v6" | "unknown";

export interface NodeCapabilities {
  /** `/YcashCpp:4.5.0/` is the v4.5.0 line, `/YcashCpp:6.2x.y/` the 6.x line. */
  line: NodeLine;
  subversion: string;
  version: number;
  /** The `yed_*` RPCs answer (`-experimentalfeatures -yellowback`); a stock node gives -32601. */
  yellowback: boolean;
  chain: string;
}

export interface NetworkInfo {
  version: number;
  subversion: string;
  protocolversion: number;
  relayfee: number;
}

export interface BlockchainInfo {
  /** "main", "test" or "regtest". */
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  consensus: {
    /** Branch id of the tip, hex without 0x ("76b809bb"). */
    chaintip: string;
    /** Branch id a tx mined in the next block is signed under (ZIP-243). */
    nextblock: string;
  };
  upgrades: Record<string, { name: string; activationheight: number; status: string; info?: string }>;
}

export interface ScriptPubKey {
  asm: string;
  hex: string;
  type: string;
  reqSigs?: number;
  addresses?: string[];
}

export interface TxOutInfo {
  bestblock: string;
  /** 0 for a mempool output (includeMempool), else depth. */
  confirmations: number;
  value: number;
  scriptPubKey: ScriptPubKey;
  version: number;
  coinbase: boolean;
}

export interface DecodedVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  scriptSig?: { asm: string; hex: string };
  sequence: number;
}

export interface DecodedVout {
  value: number;
  valueZat?: number;
  n: number;
  scriptPubKey: ScriptPubKey;
}

export interface DecodedTransaction {
  txid: string;
  overwintered: boolean;
  version: number;
  versiongroupid?: string;
  locktime: number;
  expiryheight?: number;
  vin: DecodedVin[];
  vout: DecodedVout[];
  vjoinsplit: unknown[];
  valueBalance?: number;
  vShieldedSpend?: unknown[];
  vShieldedOutput?: unknown[];
}

/** `signrawtransaction`'s per-input error (`rawtransaction.cpp` TxInErrorToJSON). */
export interface SignInputError {
  txid: string;
  vout: number;
  scriptSig: string;
  sequence: number;
  error: string;
}

export interface SignResult {
  hex: string;
  complete: boolean;
  errors?: SignInputError[];
}

export interface VerifyScriptsResult {
  complete: boolean;
  errors: SignInputError[];
}

export interface UnspentOutput {
  txid: string;
  vout: number;
  generated?: boolean;
  address?: string;
  account?: string;
  scriptPubKey: string;
  amount: number;
  amountZat?: number;
  confirmations: number;
  spendable: boolean;
}

export interface RawTxInput {
  txid: string;
  vout: number;
  sequence?: number;
}

/** `yed_validaterawtransaction` (plan Y-9): 13 fields, identical on both lines. */
export interface YedValidation {
  valid: boolean;
  verdict: string;
  type: string;
  path: string;
  /** cents */
  yedIn: number;
  /** cents */
  yedOut: number;
  /** cents */
  burned: number;
  feeZat: number;
  payee: string | null;
  blockValid: boolean;
  wouldBeRejected: boolean;
  mempoolExpiryOk: boolean;
  unconfirmedInputs: { txid: string; vout: number }[];
}

export interface YedPayload {
  [field: string]: unknown;
  valid: boolean;
  version: number;
  type: string;
  reason?: string;
  opReturnIndex?: number;
}

export interface YedPrice {
  [field: string]: unknown;
  height: number;
  pFast: number | null;
  pMid: number | null;
  pSlow: number | null;
  pMint: number | null;
  pClaim: number | null;
  armed: boolean;
  attestStatus: string;
}

/** `yed_getinfo` is large and evolving; the SDK reads only a few fields and keeps the rest opaque. */
export interface YedInfo {
  [field: string]: unknown;
}

export interface ZReceived {
  [field: string]: unknown;
  txid: string;
  amount: number;
  amountZat?: number;
  /** hex; 0xF6 followed by zeros means "no memo" */
  memo: string;
  outindex?: number;
  confirmations?: number;
  blockheight?: number;
  change?: boolean;
}

export interface ZRecipient {
  address: string;
  /** zatoshis */
  amount: bigint;
  /** hex memo, shielded recipients only */
  memo?: string;
}

export interface OperationResult {
  [field: string]: unknown;
  id: string;
  status: "queued" | "executing" | "success" | "failed" | "cancelled";
  result?: { txid: string };
  error?: { code: number; message: string };
}
