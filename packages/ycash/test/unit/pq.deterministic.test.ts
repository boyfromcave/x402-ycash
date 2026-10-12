// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// A fixed known answer for the SDK's deterministic Falcon signing (pqSignDeterministic: the channel
// vouchers' and the key-held YED signer's path). The key is pqKeygen(FN-DSA-512, 00 01 … 2f); the message
// is a0 a1 … bf; the entropy is SHAKE256("x402-ycash/channel-falcon-entropy/v1" ‖ 00 ‖ sk ‖ msg, 88). The
// expected signature was produced by noble 0.7.1 and reproduced byte for byte by the node's PQClean C
// (python x402_ycash.pq.falcon.sign with the same entropy), so a drift of the library, of the JS engine's
// floating point, or of the derivation fails here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SCHEME_FN_DSA_512, SCHEME_SLH_DSA_SHA2_128S, pqKeygen, pqSign, pqSignDeterministic, pqVerify } from "../../src/pq/index.js";
import { bytesToHex } from "../../src/tx/bytes.js";

const SEED = Uint8Array.from({ length: 48 }, (_, i) => i);
const MSG = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
const PK_SHA256 = "9cdd6a6a5de47ccc6e7433b511bcd14337e1836abf91eda94eca53607ce61626";
const SK_SHA256 = "4abe09c3471213d9abc6ed6e090c3e356263858a25de03b476df7cda88b9ae51";
const EXPECTED_SIG =
  "39c090c61db3e07aa6023c5881f587a0cf1312f2bc5cd5df8df387ee84f50ba9e52b034d011029e69f8a7d6451ccb6722d3fa9ebf4a908e8513814b46d0d41eee8ba01e870a0cf64f6871e801066db9c94c73f5efdfeee936cc0324d5bbcb5ebfa249ee107bae295df141b22cb7df5532c2e5ddd90ae7dfa51f6c19d11cd8839696d00b4d1c9e897a82fc1827e25d33b9c3cc5abdb26a5ebfacc3ded6e6352448c29e86b66e94d4b3b35494d4a43afe12ead2ee76bf16978ef6dac82ba2b7354c1eea6737a333b05c1920db9e7899a359c8bc24e3c51c1f03a56ec3a546549aa75af39500dedc3f93298de94f87b868c2771124e7cb47f6be38e6751ed6f42f123562765839471933697074388c4962613b5bc21a9d703378bcc56218cfebb729bbe32f2413b7161083ac49929ecaacb9e299326e220c99886808272998420b5c6d1bbaac7af4014e82966812f9d4fc7cba4cab02c62d9b3c350da76075f2872f84dabb72cc3aa99266a7525a2d2674c32e51e51e8f9cf1761a84d2b68e66a97b378b43ef82227b15667cb3a92afb96faa1f1cc8178c3982cd7d50e919ebd439e55569c3daac9d7e13fcc6338bbccf4b6169504ec6d164adc820986e62bc5b3366be729f6cf247520d3c20ec8b57ed947951963b908f05ad6c8ff6127f8306ce63e75c0bdd67d2e170db439ac0960dbeaa37bc8fd8bac81c9f093267715a834966a84a632922be91ad98d6a643a9f22ed4776584b24a20c6a5313349766fa7022a760fd9baa2cf3d1a0e5a2cde192f8711989ae2b70b7a0c85ba050174c5a26a1432fb233825610dd9585323311347b159dc8cfbd4dfb336b8f3bb43f8c1f0463d3384a9d4646c86267d2ce14b3a7c4c843e82c6bc1e4a7b1849bb2d81da7536dde80dfd8430ffd405b7c3fb3050d40000000000000000000000";

describe("deterministic Falcon signing (known answer)", () => {
  const kp = pqKeygen(SCHEME_FN_DSA_512, SEED);

  it("keygen from the fixed seed", () => {
    expect(createHash("sha256").update(kp.publicKey).digest("hex")).toBe(PK_SHA256);
    expect(createHash("sha256").update(kp.secretKey).digest("hex")).toBe(SK_SHA256);
  });

  it("signs the fixed message to the fixed bytes, which verify", () => {
    const sig = pqSignDeterministic(SCHEME_FN_DSA_512, kp.secretKey, MSG);
    expect(bytesToHex(sig)).toBe(EXPECTED_SIG);
    expect(pqVerify(SCHEME_FN_DSA_512, kp.publicKey, sig, MSG)).toBe(true);
  });

  it("is a function of key and message; the CSPRNG path is not", () => {
    expect(pqSignDeterministic(SCHEME_FN_DSA_512, kp.secretKey, MSG)).toEqual(pqSignDeterministic(SCHEME_FN_DSA_512, kp.secretKey, MSG));
    const other = MSG.slice();
    other[0] = (other[0] as number) ^ 1;
    expect(bytesToHex(pqSignDeterministic(SCHEME_FN_DSA_512, kp.secretKey, other))).not.toBe(EXPECTED_SIG);
    expect(bytesToHex(pqSign(SCHEME_FN_DSA_512, kp.secretKey, MSG))).not.toBe(EXPECTED_SIG);
  });

  it("leaves the secret key intact (only its copy is zeroed)", () => {
    const sk = kp.secretKey.slice();
    pqSignDeterministic(SCHEME_FN_DSA_512, kp.secretKey, MSG);
    expect(kp.secretKey).toEqual(sk);
  });

  it("SLH-DSA is its own deterministic signer", () => {
    const s = pqKeygen(SCHEME_SLH_DSA_SHA2_128S, SEED);
    expect(pqSignDeterministic(SCHEME_SLH_DSA_SHA2_128S, s.secretKey, MSG)).toEqual(pqSign(SCHEME_SLH_DSA_SHA2_128S, s.secretKey, MSG));
  });
});
