# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or https://www.opensource.org/licenses/mit-license.php .

"""SLH-DSA-SHA2-128s (FIPS 205: keygen, sign, verify) and FN-DSA-512 verification (PQClean
``falcon-padded-512`` encodings), pure Python on the standard library.

Ported verbatim from ycash-dd ``qa/rpc-tests/test_framework/pq.py`` (upgrade/quantum-vaults @ aa0fd3812),
which is written from the standards independently of the node's vendored C and checked there against
NIST ACVP and the node's vectors; this SDK re-proves byte identity against ``vectors/pq/pq_vectors.json``
(tests/unit/test_pq.py). Only the cryptography is taken: the scheme registry and the script helpers
are ``x402_ycash.pq``'s own. There is no Python Falcon signer (FN-DSA keys and signatures are not
produced here).
"""

# ruff: noqa
# mypy: ignore-errors

import hashlib
import hmac

# ---------------------------------------------------------------------------
# Scheme registry (plan §4.1)

SCHEME_SLH_DSA_SHA2_128S = 0x01
SCHEME_FN_DSA_512 = 0x02

KEYHASH_SIZE = 32
MAX_CHUNK = 520                 # == MAX_SCRIPT_ELEMENT_SIZE
SIGOP_COST = 20

PUBKEY_SIZE = {SCHEME_SLH_DSA_SHA2_128S: 32, SCHEME_FN_DSA_512: 897}
SIG_SIZE = {SCHEME_SLH_DSA_SHA2_128S: 7856, SCHEME_FN_DSA_512: 666}     # without the hashtype byte

SIGHASH_ALL = 1


def pubkey_size(scheme):
    return PUBKEY_SIZE.get(scheme, 0)


def sig_size(scheme):
    return SIG_SIZE.get(scheme, 0)


def is_known_scheme(scheme):
    return scheme in PUBKEY_SIZE


# ---------------------------------------------------------------------------
# SLH-DSA-SHA2-128s (FIPS 205)

SLH_N = 16
SLH_H = 63
SLH_D = 7
SLH_HP = 9                       # h' = h / d
SLH_A = 12
SLH_K = 14
SLH_LGW = 4
SLH_W = 16
SLH_M = 30
SLH_LEN1 = 32
SLH_LEN2 = 3
SLH_LEN = 35
SLH_PK_BYTES = 2 * SLH_N
SLH_SK_BYTES = 4 * SLH_N
SLH_SIG_BYTES = SLH_N * (1 + SLH_K * (1 + SLH_A) + SLH_H + SLH_D * SLH_LEN)   # 7856
SLH_SEED_BYTES = 3 * SLH_N       # SK.seed || SK.prf || PK.seed

# ADRS types
_WOTS_HASH, _WOTS_PK, _TREE, _FORS_TREE, _FORS_ROOTS, _WOTS_PRF, _FORS_PRF = range(7)

_U32 = [i.to_bytes(4, 'big') for i in range(1 << SLH_A)]       # every word value a hot loop needs
_Z4 = bytes(4)


def _u32(i):
    return _U32[i] if i < len(_U32) else i.to_bytes(4, 'big')


def _base_2b(x, b, out_len):
    """FIPS 205 Algorithm 4."""
    i = bits = total = 0
    out = []
    mask = (1 << b) - 1
    for _ in range(out_len):
        while bits < b:
            total = (total << 8) | x[i]
            i += 1
            bits += 8
        bits -= b
        out.append((total >> bits) & mask)
    return out


class _Ctx:
    """The SHA2 tweakable hashes for one key (FIPS 205 §11.2.1, n = 16), with SHA-256's state after
    the 64-byte ``PK.seed || toByte(0, 48)`` block precomputed and copied per call.  ADRS values
    are passed already compressed (ADRSc, 22 bytes): ``layer(1) || tree(8) || type(1) || w1 w2 w3``."""

    def __init__(self, pk_seed, sk_seed=None):
        self.pk_seed = bytes(pk_seed)
        self.sk_seed = None if sk_seed is None else bytes(sk_seed)
        self.seeded = hashlib.sha256(self.pk_seed + bytes(64 - SLH_N))

    def h(self, adrsc, m):       # F, H and T_l are the same function for n = 16
        c = self.seeded.copy()
        c.update(adrsc + m)
        return c.digest()[:SLH_N]

    def prf(self, adrsc):
        c = self.seeded.copy()
        c.update(adrsc + self.sk_seed)
        return c.digest()[:SLH_N]

    # -- WOTS+ (Algorithms 5-8) --

    def _wots_msg(self, m):
        msg = _base_2b(m, SLH_LGW, SLH_LEN1)
        csum = sum(SLH_W - 1 - v for v in msg) << 4        # (8 - (len2 * lg_w) % 8) % 8 = 4
        return msg + _base_2b(csum.to_bytes(2, 'big'), SLH_LGW, SLH_LEN2)

    def _chain(self, x, start, steps, pre):
        """``chain``; ``pre`` = ADRSc up to and including the chain address (18 bytes)."""
        seeded, n = self.seeded, SLH_N
        for j in range(start, start + steps):
            c = seeded.copy()
            c.update(pre + _U32[j] + x)
            x = c.digest()[:n]
        return x

    def wots_pk(self, lt, kp):
        """wots_pkGen for keypair ``kp`` of the XMSS tree ``lt`` (= layer(1) || tree(8))."""
        seeded, sk_seed, n = self.seeded, self.sk_seed, SLH_N
        kp4 = _u32(kp)
        prf_pre = lt + bytes([_WOTS_PRF]) + kp4
        hash_pre = lt + bytes([_WOTS_HASH]) + kp4
        out = []
        for i in range(SLH_LEN):
            i4 = _U32[i]
            c = seeded.copy()
            c.update(prf_pre + i4 + _Z4 + sk_seed)
            x = c.digest()[:n]
            pre = hash_pre + i4
            for j in range(SLH_W - 1):
                c = seeded.copy()
                c.update(pre + _U32[j] + x)
                x = c.digest()[:n]
            out.append(x)
        return self.h(lt + bytes([_WOTS_PK]) + kp4 + bytes(8), b''.join(out))

    def wots_sign(self, m, lt, kp):
        kp4 = _u32(kp)
        prf_pre = lt + bytes([_WOTS_PRF]) + kp4
        hash_pre = lt + bytes([_WOTS_HASH]) + kp4
        sig = []
        for i, v in enumerate(self._wots_msg(m)):
            sk = self.prf(prf_pre + _U32[i] + _Z4)
            sig.append(self._chain(sk, 0, v, hash_pre + _U32[i]))
        return b''.join(sig)

    def wots_pk_from_sig(self, sig, m, lt, kp):
        kp4 = _u32(kp)
        hash_pre = lt + bytes([_WOTS_HASH]) + kp4
        tmp = []
        for i, v in enumerate(self._wots_msg(m)):
            tmp.append(self._chain(sig[i * SLH_N:(i + 1) * SLH_N], v, SLH_W - 1 - v, hash_pre + _U32[i]))
        return self.h(lt + bytes([_WOTS_PK]) + kp4 + bytes(8), b''.join(tmp))

    # -- XMSS (Algorithms 9-11), whole tree at once --

    def xmss_tree(self, lt):
        """All levels of the XMSS tree ``lt``: ``levels[z][i]`` is xmss_node(i, z)."""
        level = [self.wots_pk(lt, i) for i in range(1 << SLH_HP)]
        levels = [level]
        tree_pre = lt + bytes([_TREE]) + _Z4
        for z in range(1, SLH_HP + 1):
            z4 = _U32[z]
            level = [self.h(tree_pre + z4 + _U32[i], level[2 * i] + level[2 * i + 1])
                     for i in range(len(level) // 2)]
            levels.append(level)
        return levels

    def xmss_sign(self, m, lt, idx):
        levels = self.xmss_tree(lt)
        auth = b''.join(levels[j][(idx >> j) ^ 1] for j in range(SLH_HP))
        return self.wots_sign(m, lt, idx) + auth, levels[SLH_HP][0]

    def xmss_pk_from_sig(self, idx, sig, m, lt):
        node = self.wots_pk_from_sig(sig[:SLH_LEN * SLH_N], m, lt, idx)
        auth = sig[SLH_LEN * SLH_N:]
        tree_pre = lt + bytes([_TREE]) + _Z4
        for k in range(SLH_HP):
            a = auth[k * SLH_N:(k + 1) * SLH_N]
            idx_k = idx >> k
            adrs = tree_pre + _u32(k + 1) + _u32(idx_k >> 1)
            node = self.h(adrs, node + a) if idx_k % 2 == 0 else self.h(adrs, a + node)
        return node

    # -- FORS (Algorithms 14-17) --

    def _fors_pre(self, idx_tree, idx_leaf):
        return bytes([0]) + idx_tree.to_bytes(8, 'big'), _u32(idx_leaf)

    def fors_sign(self, md, idx_tree, idx_leaf):
        lt, kp4 = self._fors_pre(idx_tree, idx_leaf)
        prf_pre = lt + bytes([_FORS_PRF]) + kp4 + _Z4
        node_pre = lt + bytes([_FORS_TREE]) + kp4
        seeded, sk_seed, n = self.seeded, self.sk_seed, SLH_N
        out = []
        for i, ix in enumerate(_base_2b(md, SLH_A, SLH_K)):
            base = i << SLH_A
            # leaves of tree i (height 0, index base + j)
            level = []
            h0 = node_pre + _Z4
            for j in range(1 << SLH_A):
                t4 = _u32(base + j)
                c = seeded.copy()
                c.update(prf_pre + t4 + sk_seed)
                sk = c.digest()[:n]
                if j == ix:
                    out.append(sk)
                c = seeded.copy()
                c.update(h0 + t4 + sk)
                level.append(c.digest()[:n])
            for z in range(SLH_A):
                out.append(level[(ix >> z) ^ 1])
                if z == SLH_A - 1:
                    break
                zb = node_pre + _u32(z + 1)
                off = base >> (z + 1)
                level = [self.h(zb + _u32(off + q), level[2 * q] + level[2 * q + 1]) for q in range(len(level) // 2)]
        return b''.join(out)

    def fors_pk_from_sig(self, sig, md, idx_tree, idx_leaf):
        lt, kp4 = self._fors_pre(idx_tree, idx_leaf)
        node_pre = lt + bytes([_FORS_TREE]) + kp4
        roots = []
        step = (1 + SLH_A) * SLH_N
        for i, ix in enumerate(_base_2b(md, SLH_A, SLH_K)):
            part = sig[i * step:(i + 1) * step]
            ti = (i << SLH_A) + ix
            node = self.h(node_pre + _Z4 + _u32(ti), part[:SLH_N])
            for j in range(SLH_A):
                a = part[(1 + j) * SLH_N:(2 + j) * SLH_N]
                if (ix >> j) % 2 == 0:
                    ti >>= 1
                    node = self.h(node_pre + _u32(j + 1) + _u32(ti), node + a)
                else:
                    ti = (ti - 1) >> 1
                    node = self.h(node_pre + _u32(j + 1) + _u32(ti), a + node)
            roots.append(node)
        return self.h(lt + bytes([_FORS_ROOTS]) + kp4 + bytes(8), b''.join(roots))


def _lt(layer, tree):
    return bytes([layer]) + tree.to_bytes(8, 'big')


def _ht_layer_job(args):
    """One hypertree layer's XMSS tree root and auth path (for the process pool)."""
    pk_seed, sk_seed, layer, tree = args
    levels = _Ctx(pk_seed, sk_seed).xmss_tree(_lt(layer, tree))
    return levels


def _ht_indices(idx_tree, idx_leaf):
    """[(layer, tree, leaf)] for d layers (Algorithm 12's walk)."""
    out = [(0, idx_tree, idx_leaf)]
    for j in range(1, SLH_D):
        idx_leaf = idx_tree & ((1 << SLH_HP) - 1)
        idx_tree >>= SLH_HP
        out.append((j, idx_tree, idx_leaf))
    return out


def _h_msg(r, pk_seed, pk_root, m):
    seed = r + pk_seed + hashlib.sha256(r + pk_seed + pk_root + m).digest()
    out = b''
    c = 0
    while len(out) < SLH_M:
        out += hashlib.sha256(seed + c.to_bytes(4, 'big')).digest()
        c += 1
    return out[:SLH_M]


def _split_digest(digest):
    md = digest[:21]                                        # ceil(k * a / 8)
    idx_tree = int.from_bytes(digest[21:28], 'big') & ((1 << (SLH_H - SLH_HP)) - 1)
    idx_leaf = int.from_bytes(digest[28:30], 'big') & ((1 << SLH_HP) - 1)
    return md, idx_tree, idx_leaf


def slh_keygen_internal(sk_seed, sk_prf, pk_seed):
    """FIPS 205 Algorithm 18: returns ``(sk 64, pk 32)``."""
    ctx = _Ctx(pk_seed, sk_seed)
    root = ctx.xmss_tree(_lt(SLH_D - 1, 0))[SLH_HP][0]
    pk = bytes(pk_seed) + root
    return bytes(sk_seed) + bytes(sk_prf) + pk, pk


def slh_keygen(seed48):
    """KeyGen from the 48-byte seed ``SK.seed || SK.prf || PK.seed`` (the wallet's derivation, plan
    §4.6, and ``pq::KeyGen``). Returns ``(pk 32, sk 64)`` in the C API's order."""
    seed48 = bytes(seed48)
    assert len(seed48) == SLH_SEED_BYTES
    sk, pk = slh_keygen_internal(seed48[:16], seed48[16:32], seed48[32:48])
    return pk, sk


def slh_sign_internal(m, sk, addrnd=None, processes=1):
    """FIPS 205 Algorithm 19; ``addrnd`` None = deterministic (``opt_rand = PK.seed``)."""
    sk = bytes(sk)
    assert len(sk) == SLH_SK_BYTES
    sk_seed, sk_prf, pk_seed, pk_root = sk[:16], sk[16:32], sk[32:48], sk[48:64]
    opt_rand = pk_seed if addrnd is None else bytes(addrnd)
    m = bytes(m)
    r = hmac.new(sk_prf, opt_rand + m, hashlib.sha256).digest()[:SLH_N]
    md, idx_tree, idx_leaf = _split_digest(_h_msg(r, pk_seed, pk_root, m))
    ctx = _Ctx(pk_seed, sk_seed)
    sig_fors = ctx.fors_sign(md, idx_tree, idx_leaf)
    node = ctx.fors_pk_from_sig(sig_fors, md, idx_tree, idx_leaf)
    walk = _ht_indices(idx_tree, idx_leaf)
    if processes and processes > 1:
        import multiprocessing
        method = 'fork' if 'fork' in multiprocessing.get_all_start_methods() else 'spawn'
        with multiprocessing.get_context(method).Pool(min(processes, SLH_D)) as pool:
            trees = pool.map(_ht_layer_job, [(pk_seed, sk_seed, layer, tree) for layer, tree, _ in walk])
    else:
        trees = None
    parts = [r, sig_fors]
    for j, (layer, tree, leaf) in enumerate(walk):
        lt = _lt(layer, tree)
        levels = trees[j] if trees else ctx.xmss_tree(lt)
        auth = b''.join(levels[z][(leaf >> z) ^ 1] for z in range(SLH_HP))
        parts.append(ctx.wots_sign(node, lt, leaf) + auth)
        node = levels[SLH_HP][0]          # == xmss_pkFromSig of what was just signed
    sig = b''.join(parts)
    assert len(sig) == SLH_SIG_BYTES
    return sig


def slh_verify_internal(m, sig, pk):
    """FIPS 205 Algorithm 20."""
    sig, pk, m = bytes(sig), bytes(pk), bytes(m)
    if len(sig) != SLH_SIG_BYTES or len(pk) != SLH_PK_BYTES:
        return False
    pk_seed, pk_root = pk[:16], pk[16:]
    r = sig[:SLH_N]
    fors_len = SLH_K * (1 + SLH_A) * SLH_N
    sig_fors = sig[SLH_N:SLH_N + fors_len]
    sig_ht = sig[SLH_N + fors_len:]
    md, idx_tree, idx_leaf = _split_digest(_h_msg(r, pk_seed, pk_root, m))
    ctx = _Ctx(pk_seed)
    node = ctx.fors_pk_from_sig(sig_fors, md, idx_tree, idx_leaf)
    xl = (SLH_HP + SLH_LEN) * SLH_N
    for j, (layer, tree, leaf) in enumerate(_ht_indices(idx_tree, idx_leaf)):
        node = ctx.xmss_pk_from_sig(leaf, sig_ht[j * xl:(j + 1) * xl], node, _lt(layer, tree))
    return node == pk_root


def _pure_msg(m, ctx):
    ctx = bytes(ctx)
    if len(ctx) > 255:
        raise ValueError('context longer than 255 bytes')
    return bytes([0, len(ctx)]) + ctx + bytes(m)


def slh_sign(sk, m, ctx=b'', addrnd=None, processes=1):
    """FIPS 205 Algorithm 22 (pure SLH-DSA), deterministic unless ``addrnd`` is given. The node's
    scheme ``0x01`` is this with ``ctx`` empty."""
    return slh_sign_internal(_pure_msg(m, ctx), sk, addrnd, processes)


def slh_verify(pk, m, sig, ctx=b''):
    """FIPS 205 Algorithm 24 (pure SLH-DSA)."""
    if len(bytes(ctx)) > 255:
        return False
    return slh_verify_internal(_pure_msg(m, ctx), sig, pk)


# ---------------------------------------------------------------------------
# FN-DSA-512 verification, PQClean falcon-padded-512 encodings

FALCON_Q = 12289
FALCON_LOGN = 9
FALCON_N = 512
FALCON_NONCE = 40
FALCON_PK_BYTES = 897
FALCON_SIG_BYTES = 666
FALCON_L2BOUND = 34034726


def _falcon_decode_pk(pk):
    """``modq_decode``: header 0x09, then 512 14-bit big-endian-packed coefficients, each < q."""
    if len(pk) != FALCON_PK_BYTES or pk[0] != 0x00 + FALCON_LOGN:
        return None
    v = int.from_bytes(pk[1:], 'big')            # 896 bytes = 512 * 14 bits exactly
    h = []
    for i in range(FALCON_N):
        c = (v >> (14 * (FALCON_N - 1 - i))) & 0x3FFF
        if c >= FALCON_Q:
            return None
        h.append(c)
    return h


def _falcon_comp_decode(buf):
    """``comp_decode``: returns ``(coefficients, bytes consumed)`` or None."""
    n_in = len(buf)
    x = []
    acc = acc_len = v = 0
    for _ in range(FALCON_N):
        if v >= n_in:
            return None
        acc = ((acc << 8) | buf[v]) & 0xFFFFFFFF
        v += 1
        b = acc >> acc_len
        s = b & 128
        m = b & 127
        while True:
            if acc_len == 0:
                if v >= n_in:
                    return None
                acc = ((acc << 8) | buf[v]) & 0xFFFFFFFF
                v += 1
                acc_len = 8
            acc_len -= 1
            if (acc >> acc_len) & 1:
                break
            m += 128
            if m > 2047:
                return None
        if s and m == 0:
            return None
        x.append(-m if s else m)
    if acc & ((1 << acc_len) - 1):
        return None
    return x, v


def _falcon_hash_to_point(nonce, m):
    """SHAKE256(nonce || m), 16-bit big-endian samples, reject >= 61445 (5q), reduce mod q."""
    out = []
    want = 2 * FALCON_N * 2
    while True:
        stream = hashlib.shake_256(nonce + m).digest(want)
        out = []
        for i in range(0, want, 2):
            w = (stream[i] << 8) | stream[i + 1]
            if w < 61445:
                out.append(w % FALCON_Q)
                if len(out) == FALCON_N:
                    return out
        want *= 2


def _negacyclic_mul_modq(a, b):
    """a * b in Z_q[x] / (x^512 + 1), Kronecker substitution on Python integers (exact)."""
    sh = 64
    ia = sum(c << (sh * i) for i, c in enumerate(a))
    ib = sum(c << (sh * i) for i, c in enumerate(b))
    p = ia * ib
    mask = (1 << sh) - 1
    coef = [(p >> (sh * i)) & mask for i in range(2 * FALCON_N - 1)]
    return [(coef[i] - (coef[i + FALCON_N] if i + FALCON_N < len(coef) else 0)) % FALCON_Q
            for i in range(FALCON_N)]


def falcon_verify(pk, m, sig):
    """PQClean ``falcon-padded-512`` ``crypto_sign_verify(sig, 666, m, pk)`` == 0."""
    pk, sig, m = bytes(pk), bytes(sig), bytes(m)
    if len(sig) != FALCON_SIG_BYTES or sig[0] != 0x30 + FALCON_LOGN:
        return False
    h = _falcon_decode_pk(pk)
    if h is None:
        return False
    nonce = sig[1:1 + FALCON_NONCE]
    body = sig[1 + FALCON_NONCE:]
    dec = _falcon_comp_decode(body)
    if dec is None:
        return False
    s2, used = dec
    if any(body[used:]):                         # the padding must be zero
        return False
    c0 = _falcon_hash_to_point(nonce, m)
    s2h = _negacyclic_mul_modq([c % FALCON_Q for c in s2], h)
    norm = 0
    for i in range(FALCON_N):
        w = (c0[i] - s2h[i]) % FALCON_Q
        if w > FALCON_Q // 2:
            w -= FALCON_Q
        norm += w * w
    norm += sum(c * c for c in s2)
    return norm <= FALCON_L2BOUND
