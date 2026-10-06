// The lightwalletd messages this adapter reads, as @grpc/proto-loader decodes them (keepCase,
// defaults, 64-bit integers as decimal strings, bytes as Buffer). Field names and numbers are the
// vendored protos' (proto/service.proto, proto/yellowback.proto); only the fields used are typed.

/** `LightdInfo` (service.proto:57-72). */
export interface LightdInfo {
  version: string;
  vendor: string;
  taddrSupport: boolean;
  /** getblockchaininfo `chain`: "main", "test" or "regtest". */
  chainName: string;
  saplingActivationHeight: string;
  /** getblockchaininfo `consensus.chaintip`, hex (lightwalletd-dd/common/common.go:212), not `nextblock`. */
  consensusBranchId: string;
  blockHeight: string;
  estimatedHeight: string;
  zcashdBuild: string;
  zcashdSubversion: string;
}

/** `YedChainInfo` (yellowback.proto:186-192): what a client needs to sign for the next block (X-F71). */
export interface YedChainInfoMsg {
  chainName: string;
  blockHeight: string;
  /** getblockchaininfo `consensus.chaintip`, hex. */
  consensusBranchId: string;
  /** getblockchaininfo `consensus.nextblock`, hex: differs from the chaintip's on the block before an upgrade. */
  nextBlockBranchId: string;
}

/** `GetAddressUtxosReply` (service.proto:133-140); txid in internal (little-endian) byte order. */
export interface AddressUtxoMsg {
  address: string;
  txid: Buffer;
  index: number;
  script: Buffer;
  valueZat: string;
  height: string;
}

/** `RawTransaction` (service.proto:36-39). `height` is 0 (or -1 as uint64) while in the mempool. */
export interface RawTransactionMsg {
  data: Buffer;
  height: string;
}

/** `SendResponse` (service.proto:44-47): code 0 and the txid as JSON, or the node's code and message. */
export interface SendResponseMsg {
  errorCode: number;
  errorMessage: string;
}

/** `CompactTx` (compact_formats.proto): only its hash is read. */
export interface CompactTxMsg {
  index: string;
  hash: Buffer;
}

/** `YedToken` (yellowback.proto:35-38): one `yed_listtokens` record; txid in display order. */
export interface YedTokenMsg {
  txid: string;
  vout: number;
  cents: string;
  valueZat: string;
  height: string;
  address: string;
  transparentAddress: string;
}

/** `YedValidation` (yellowback.proto:93-97): `yed_validaterawtransaction`. */
export interface YedValidationMsg {
  blockValid: boolean;
  burned: string;
  feeZat: string;
  mempoolExpiryOk: boolean;
  path: string;
  payee: string;
  type: string;
  unconfirmedInputs: { txid: string; vout: number }[];
  valid: boolean;
  verdict: string;
  wouldBeRejected: boolean;
  yedIn: string;
  yedOut: string;
}
