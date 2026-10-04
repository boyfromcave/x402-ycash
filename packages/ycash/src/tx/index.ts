// x402-ycash: tx. The v4 transaction codec, the ZIP-243 sighash, keys and signing, scripts,
// addresses and the fee rule (plan §5.4, §5.6, §5.7; X1).
export {
  parseTx, serializeTx, serializeTxHex, txid, newTx, hasShielded,
  TX_VERSION, SAPLING_VERSION_GROUP_ID, SEQUENCE_FINAL,
  type Tx, type TxIn, type TxOut, type OutPoint, type SpendDescription, type OutputDescription,
} from "./tx.js";
export { sighashV4, SIGHASH } from "./sighash.js";
export {
  signInput, verifyInputSig, sigHashType, pubkeyFromPriv, randomPrivKey, decodeWif, encodeWif,
  type DecodedWif,
} from "./keys.js";
export { hash160, sha256d, blake2b256 } from "./hash.js";
export {
  OP, pushData, pushInt, scriptNum, decodeScriptNum, buildScript, parseScript,
  p2pkhScript, p2shScript, opReturnScript, p2pkhHash, p2shHash, p2pkhScriptSig, p2shScriptSig,
  type ScriptItem, type ScriptChunk,
} from "./script.js";
export { encodeAddress, decodeAddress, addressToScript, type AddressKind, type DecodedAddress } from "./address.js";
export { logicalActions, feeFloor, txFee, MARGINAL_FEE, GRACE_ACTIONS, MIN_FEE } from "./fee.js";
export { hexToBytes, bytesToHex, concatBytes, equalBytes } from "./bytes.js";
export { base58CheckEncode, base58CheckDecode } from "./base58.js";
