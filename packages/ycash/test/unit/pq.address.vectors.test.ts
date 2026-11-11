// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// The node lines' shared post-quantum address vectors (decision D-9): vectors/pq/pq_address_vectors.json is
// ycash-dd / ycash6 src/test/data/pq_address_vectors.json byte for byte (up/b2-pq-prefix); its sha256 is pinned.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { YCASH_MAINNET, YCASH_NETWORKS, YCASH_REGTEST, YCASH_TESTNET, type YcashNetwork } from "../../src/constants.js";
import { bytesToHex, decodeAddress, encodePQAddress, hexToBytes, pqVersion } from "../../src/tx/index.js";

const SHA256 = "dbbd1da05d995d659e1e9f8a671197e141c272998722d6cca85cdbdb52b61797";
const raw = readFileSync(fileURLToPath(new URL("../../../../vectors/pq/pq_address_vectors.json", import.meta.url)));
interface Valid { network: string; coin: string; scheme: number; version: string; keyhash: string; address: string }
interface Invalid { network: string; coin: string; reason: string; address: string }
const v = JSON.parse(raw.toString("utf8")) as { format: string; valid: Valid[]; invalid: Invalid[] };
const NET: Record<string, YcashNetwork> = { main: YCASH_MAINNET, test: YCASH_TESTNET, regtest: YCASH_REGTEST };

describe("post-quantum address vectors (D-9, the node lines' pq_address_vectors.json)", () => {
  it("is the node lines' file: hash, format and counts", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(SHA256);
    expect(v.format).toBe("ycash-pq-address-vectors-1");
    expect([v.valid.length, v.invalid.length]).toEqual([72, 60]);
  });

  it("every valid vector decodes to its network, kind, scheme and key hash, on its own network only, and re-encodes", () => {
    for (const c of v.valid) {
      const network = NET[c.network] as YcashNetwork;
      const kind = c.coin === "yed" ? "yedpq" : "pq";
      const hash = hexToBytes(c.keyhash);
      expect(bytesToHex(Uint8Array.from(pqVersion(network, kind, c.scheme)))).toBe(c.version);
      expect(decodeAddress(c.address)).toEqual({ network, kind, hash, scheme: c.scheme });
      expect(decodeAddress(c.address, network)).toEqual({ network, kind, hash, scheme: c.scheme });
      expect(encodePQAddress(network, kind, { scheme: c.scheme as 1 | 2, hash })).toBe(c.address);
      for (const other of YCASH_NETWORKS.filter((n) => n !== network)) expect(() => decodeAddress(c.address, other)).toThrow();
    }
  });

  it("every invalid vector is refused on every network", () => {
    for (const c of v.invalid) {
      expect(() => decodeAddress(c.address), `${c.address} (${c.reason})`).toThrow();
      for (const n of YCASH_NETWORKS) expect(() => decodeAddress(c.address, n), `${c.address} on ${n}`).toThrow();
    }
  });
});
