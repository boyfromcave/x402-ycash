"""The Sapling Pedersen hash and note commitment (Zcash protocol spec §5.4.1.7, §5.4.8.2), as
sapling-crypto 0.7 computes them (``pedersen_hash.rs:33-120``, ``note/commitment.rs:36-52``). Mirrors
packages/ycash/src/shielded/sapling/pedersen.ts."""

from __future__ import annotations

from collections.abc import Sequence

from .jubjub import IDENTITY, Point, R, add, affine, find_group_hash, mul

PEDERSEN_PERSONALIZATION = b"Zcash_PH"
CHUNKS_PER_GENERATOR = 63
"""c = 63 chunks of 3 bits per generator (``constants.rs:234``)."""
NOTE_COMMITMENT_PREFIX = (1, 1, 1, 1, 1, 1)

_generators: list[Point] = []
_randomness_base: list[Point] = []


def generator(i: int) -> Point:
    """I_i = FindGroupHash("Zcash_PH", I2LEOSP_32(i)), computed once."""
    while len(_generators) <= i:
        _generators.append(find_group_hash(len(_generators).to_bytes(4, "little"), PEDERSEN_PERSONALIZATION))
    return _generators[i]


def note_commitment_randomness_base() -> Point:
    """FindGroupHash("Zcash_PH", "r") (``constants.rs:312-316``)."""
    if not _randomness_base:
        _randomness_base.append(find_group_hash(b"r", PEDERSEN_PERSONALIZATION))
    return _randomness_base[0]


def pedersen_hash_to_point(bits: Sequence[int]) -> Point:
    """PedersenHashToPoint over bits whose personalization is already prepended: each 3-bit chunk
    is (1 − 2·s₂)(1 + s₀ + 2·s₁), chunk j of a segment weighs 2^(4j), segment i scales I_i."""
    result = IDENTITY
    pos, segment, n = 0, 0, len(bits)
    while pos < n:
        acc, cur = 0, 1
        for _ in range(CHUNKS_PER_GENERATOR):
            if pos >= n:
                break
            a = bits[pos]
            b = bits[pos + 1] if pos + 1 < n else 0
            neg = bits[pos + 2] if pos + 2 < n else 0
            chunk = cur * (1 + a + 2 * b)
            acc += -chunk if neg else chunk
            cur <<= 4
            pos += 3
        scalar = acc % R
        if scalar:
            result = add(result, mul(generator(segment), scalar))
        segment += 1
    return result


def le_bits(data: bytes) -> list[int]:
    """Little-endian bit order over bytes: LSB of byte 0 first."""
    return [(b >> i) & 1 for b in data for i in range(8)]


def note_commitment(gd: bytes, pkd: bytes, value: int, rcm: int) -> Point:
    """NoteCommit^Sapling_rcm(g_d, pk_d, v) = WindowedPedersenCommit_rcm([1]⁶ ‖ I2LEBSP_64(v) ‖ g_d ‖ pk_d)."""
    bits = [*NOTE_COMMITMENT_PREFIX, *le_bits(value.to_bytes(8, "little")), *le_bits(gd), *le_bits(pkd)]
    h = pedersen_hash_to_point(bits)
    r = rcm % R
    return h if r == 0 else add(h, mul(note_commitment_randomness_base(), r))


def extract_u(p: Point) -> bytes:
    """Extract^J(r): the u-coordinate, 32 little-endian bytes (how cmu is written in an output)."""
    return affine(p)[0].to_bytes(32, "little")
