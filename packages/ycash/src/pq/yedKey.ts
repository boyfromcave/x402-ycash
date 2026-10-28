// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// A key-held Falcon YED key: the post-quantum counterpart of a WIF for an agent with no node wallet.
// From the node's Falcon height F (mainnet and testnet: the vault activation, D-Q-2) only a Falcon
// (scheme-2) TX_PQPKH holds YED (TOK-PQ), so an agent that holds its own keys needs one to hold or pay YED.
//
// - The secret is the 48-byte FN-DSA-512 keygen seed (PQClean's DRBG seed, as the node's pq::KeyGen takes
//   it), written as text `fn-dsa-512:<96 hex>` (a bare 96-hex line is accepted too). The key pair is
//   pqKeygen(FN-DSA-512, seed), so a seed restores the same key here and in any PQClean-based signer.
// - The holder script is TX_PQPKH `20 <SHA256(0x02 ‖ pk)> 52 c2` (quantum spec §2), its YED address the
//   33-byte scheme ‖ key-hash payload under the network's PQ YED version (mainnet `yb…` 56 AB, testnet
//   `yt…` 57 1E, regtest `yr…` 57 10; 53 characters), and its plain-YEC form `sq…`/`tq…`/`rq…`.
// - A spend is the chunked `<sig_1> <sig_2> OP_2 <pk_1> <pk_2> OP_2` (520 + 147, 520 + 377), the hash type
//   ALL on the signature's last byte, over the ZIP-243 sighash with the TX_PQPKH as script code.
import type { YcashNetwork } from "../constants.js";
import { encodePQAddress } from "../tx/address.js";
import { bytesToHex, equalBytes, hexToBytes } from "../tx/bytes.js";
import { buildScript } from "../tx/script.js";
import { SIGHASH, sighashV4 } from "../tx/sighash.js";
import type { Tx } from "../tx/tx.js";
import { SCHEME_FN_DSA_512, SEED_SIZE, keyIdOf, type PQKeyId } from "./scheme.js";
import { pqpkhScript, pqSpendItems } from "./script.js";
import { pqKeygen, pqSignDeterministic, type PQKeyPair } from "./sign.js";

/** The text label of a Falcon YED key seed. */
export const YED_KEY_LABEL = "fn-dsa-512";

/** A Falcon YED holder key: the key pair, its key id and its TX_PQPKH holder script. */
export interface YedFalconKey {
  keyPair: PQKeyPair;
  id: PQKeyId;
  /** `20 <keyHash> 52 c2` */
  script: Uint8Array;
}

/**
 * The Falcon YED key of a 48-byte seed.
 *
 * @param seed - The FN-DSA-512 keygen seed.
 * @returns The key, its id and its holder script.
 * @throws Error when the seed is not 48 bytes.
 */
export function yedFalconKeyFromSeed(seed: Uint8Array): YedFalconKey {
  const keyPair = pqKeygen(SCHEME_FN_DSA_512, seed);
  const id = keyIdOf(SCHEME_FN_DSA_512, keyPair.publicKey);
  return { keyPair, id, script: pqpkhScript(id) };
}

/**
 * Parses a seed file's text: `fn-dsa-512:<96 hex>`, or the 96 hex alone; surrounding whitespace ignored.
 *
 * @param text - The file's contents (or an environment value).
 * @returns The 48-byte seed.
 * @throws Error on any other form (the message never echoes the secret).
 */
export function parseYedKeySeed(text: string): Uint8Array {
  const t = text.trim();
  const hex = t.startsWith(`${YED_KEY_LABEL}:`) ? t.slice(YED_KEY_LABEL.length + 1) : t;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== SEED_SIZE * 2) {
    throw new Error(`a Falcon YED key is "${YED_KEY_LABEL}:" followed by ${SEED_SIZE * 2} hex digits (a ${SEED_SIZE}-byte seed)`);
  }
  return hexToBytes(hex.toLowerCase());
}

/**
 * The text form of a seed, as {@link parseYedKeySeed} reads it.
 *
 * @param seed - The 48-byte seed.
 * @returns `fn-dsa-512:<96 hex>` and a newline.
 */
export function formatYedKeySeed(seed: Uint8Array): string {
  if (seed.length !== SEED_SIZE) throw new Error(`a Falcon YED key seed is ${SEED_SIZE} bytes`);
  return `${YED_KEY_LABEL}:${bytesToHex(seed)}\n`;
}

/**
 * The key's YED address (`yb…`/`yt…`/`yr…`, the 53-character post-quantum form).
 *
 * @param network - The network.
 * @param key - The key.
 * @returns The address.
 */
export function yedFalconAddress(network: YcashNetwork, key: YedFalconKey): string {
  return encodePQAddress(network, "yedpq", key.id);
}

/**
 * The key's plain-YEC post-quantum address (`sq…`/`tq…`/`rq…`): the same TX_PQPKH script.
 *
 * @param network - The network.
 * @param key - The key.
 * @returns The address.
 */
export function yedFalconPlainAddress(network: YcashNetwork, key: YedFalconKey): string {
  return encodePQAddress(network, "pq", key.id);
}

/**
 * Signs vin[i], a coin of the key's TX_PQPKH, SIGHASH_ALL in place: the chunked spend over the ZIP-243
 * sighash with the TX_PQPKH as script code. The signature is the SDK's deterministic Falcon signature
 * ({@link pqSignDeterministic}); nothing depends on that for validity.
 *
 * @param tx - The transaction (its other inputs may still be unsigned).
 * @param i - The input index.
 * @param key - The key.
 * @param coin - The spent coin's value and scriptPubKey (must be the key's script).
 * @param coin.value - Its value, zatoshis.
 * @param coin.scriptPubKey - Its script.
 * @param branchId - The consensus branch id.
 * @throws Error when the coin is not the key's TX_PQPKH.
 */
export function signYedFalconInput(tx: Tx, i: number, key: YedFalconKey, coin: { value: bigint; scriptPubKey: Uint8Array }, branchId: number): void {
  if (!equalBytes(coin.scriptPubKey, key.script)) throw new Error(`input ${i} is not a coin of this Falcon key`);
  const vin = tx.vin[i];
  if (!vin) throw new Error(`no input ${i}`);
  const digest = sighashV4(tx, i, key.script, coin.value, SIGHASH.ALL, branchId);
  const sig = pqSignDeterministic(SCHEME_FN_DSA_512, key.keyPair.secretKey, digest);
  const withType = new Uint8Array(sig.length + 1);
  withType.set(sig);
  withType[sig.length] = SIGHASH.ALL;
  vin.scriptSig = buildScript(pqSpendItems(key.keyPair.publicKey, withType));
}
