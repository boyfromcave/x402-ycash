"""The Jubjub curve, pure Python: the twisted Edwards curve −u² + v² = 1 + d·u²·v² over the BLS12-381
scalar field (Zcash protocol spec §5.4.9.3), with the point encoding and group hash Sapling uses
(sapling-crypto 0.7 ``group_hash.rs``; jubjub 0.10 ``AffinePoint::from_bytes``). Mirrors what
packages/ycash/src/shielded/sapling uses from @noble/curves ``misc.js``.

Points are extended coordinates (X, Y, Z, T) with u = X/Z, v = Y/Z, T = XY/Z. Only public data is
multiplied here (a viewing key's ivk is secret, but the facilitator holds it on its own machine), so
the arithmetic is plain double-and-add, not constant time.
"""

from __future__ import annotations

import hashlib

P = 0x73EDA753299D7D483339D80809A1D80553BDA402FFFE5BFEFFFFFFFF00000001
"""The base field: BLS12-381's scalar field r."""
R = 0x0E7DB4EA6533AFA906673B0101343B00A6682093CCC81082D0970E5ED6F72CB7
"""The prime order of the subgroup (sapling-crypto's ``jubjub::Fr``)."""
D = 0x2A9318E74BFA2B48F5FD9207E6BD7FD4292D7F6D37579D2601065FD6D6343EB1
_K = 2 * D % P
_GX = 0x11DAFE5D23E1218086A365B99FBF3D3BE72F6AFD7D1F72623E6B071492D1122B
_GY = 0x1D523CF1DDAB1A1793132E78C866C0C33E26BA5CC220FED7CC3F870E59D292AA

Point = tuple[int, int, int, int]
IDENTITY: Point = (0, 1, 1, 0)
BASE: Point = (_GX, _GY, 1, _GX * _GY % P)

GROUP_HASH_URS = b"096b36a5804bfacef1691e173c366a47ff5ba84a44f26ddd7e8d9f79d5b42df0"
"""The first BLAKE2s block of every group hash (spec §5.4.9.5, URS)."""


def add(a: Point, b: Point) -> Point:
    """Unified addition for a = −1 (Hisil–Wong–Carter–Dawson, "add-2008-hwcd-3"); complete on
    Jubjub because d is not a square, so it also doubles."""
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    aa = (y1 - x1) * (y2 - x2) % P
    bb = (y1 + x1) * (y2 + x2) % P
    cc = t1 * _K % P * t2 % P
    dd = 2 * z1 * z2 % P
    e, f, g, h = bb - aa, dd - cc, dd + cc, bb + aa
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def mul(p: Point, n: int) -> Point:
    """[n]·p for n ≥ 0, double-and-add from the top bit."""
    if n < 0:
        raise ValueError("negative scalar")
    acc = IDENTITY
    for bit in bin(n)[2:] if n else "":
        acc = add(acc, acc)
        if bit == "1":
            acc = add(acc, p)
    return acc


def is_identity(p: Point) -> bool:
    return p[0] % P == 0 and (p[1] - p[2]) % P == 0


def affine(p: Point) -> tuple[int, int]:
    """(u, v)."""
    zi = pow(p[2], P - 2, P)
    return p[0] * zi % P, p[1] * zi % P


def encode(p: Point) -> bytes:
    """repr_J: v as 32 little-endian bytes, the top bit the parity of u (spec §5.4.9.3)."""
    u, v = affine(p)
    return (v | ((u & 1) << 255)).to_bytes(32, "little")


def _sqrt(a: int) -> int | None:
    """A square root mod P (Tonelli–Shanks: P − 1 = 2^32 · t), or None for a non-residue."""
    a %= P
    if a == 0:
        return 0
    if pow(a, (P - 1) // 2, P) != 1:
        return None
    s, t = 0, P - 1
    while t % 2 == 0:
        s, t = s + 1, t // 2
    z = 7  # the field's multiplicative generator, a non-residue
    m, c, x, b = s, pow(z, t, P), pow(a, (t + 1) // 2, P), pow(a, t, P)
    while b != 1:
        i, b2 = 0, b
        while b2 != 1:
            b2, i = b2 * b2 % P, i + 1
        f = pow(c, 1 << (m - i - 1), P)
        m, c, x, b = i, f * f % P, x * f % P, b * f * f % P
    return x


def decode(data: bytes) -> Point | None:
    """abst_J: the point a 32-byte encoding names, or None. A non-canonical v (≥ P) and the
    encoding of u = 0 with the sign bit set are refused, as jubjub 0.10 (ZIP 216) refuses them."""
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    if y >= P:
        return None
    yy = y * y % P
    u = _sqrt((yy - 1) * pow((D * yy + 1) % P, P - 2, P))
    if u is None:
        return None
    if u == 0 and sign:
        return None
    if (u & 1) != sign:
        u = P - u
    return (u, y, 1, u * y % P)


def group_hash(tag: bytes, personalization: bytes) -> Point | None:
    """GroupHash^J(r*)(D, M): BLAKE2s-256(D, URS ‖ M) decoded and multiplied by the cofactor 8; None
    when the hash is not a point or lands in the small-order subgroup (``group_hash.rs``)."""
    h = hashlib.blake2s(GROUP_HASH_URS + tag, digest_size=32, person=personalization).digest()
    p = decode(h)
    if p is None:
        return None
    p8 = mul(p, 8)
    return None if is_identity(p8) else p8


def find_group_hash(m: bytes, personalization: bytes) -> Point:
    """FindGroupHash^J(r*)(D, M): the first i in 0..255 for which GroupHash(D, M ‖ [i]) is a point."""
    for i in range(256):
        p = group_hash(m + bytes([i]), personalization)
        if p is not None:
            return p
    raise ValueError("find_group_hash: tag overflow")
