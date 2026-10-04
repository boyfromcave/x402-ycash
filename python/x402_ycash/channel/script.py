"""The channel redeem script (specs/scheme_batch_settlement_ycash.md, "Redeem script"):

    OP_IF   OP_2 <C> <S> OP_2 OP_CHECKMULTISIG
    OP_ELSE <t> OP_CHECKLOCKTIMEVERIFY OP_DROP <C> OP_CHECKSIG
    OP_ENDIF

3 sigops, standard under the 15-sigop P2SH limit (ycash-dd/src/policy/policy.cpp:174-179, ycash6
:204-209). CLTV is enforced on both lines (ycash-dd/src/script/interpreter.cpp:346; ycash6 :349).
"""

from __future__ import annotations

from dataclasses import dataclass

import coincurve

from ..tx import OP, Num, build_script, decode_script_num, encode_address, hash160, p2sh_script, parse_script

DEFAULT_MIN_LOCK_BLOCKS = 1152
"""Least t − tip a server accepts at open: about 24 h at 75 s."""
DEFAULT_CLOSE_MARGIN_BLOCKS = 96
"""The server stops accepting vouchers and closes at t − this: about 2 h."""
DEFAULT_CLOSE_FEE = 1500
"""The close fee every voucher reserves: the floor of a one-input (3 logical actions), two-output close."""
DUST_THRESHOLD = 54
LOCKTIME_THRESHOLD = 500_000_000
"""nLockTime values from here on are Unix times (src/script/script.h)."""
REFUND_SEQUENCE = 0xFFFFFFFE
"""A non-final nSequence: CLTV needs one, or nLockTime is ignored."""


@dataclass(frozen=True)
class ChannelScript:
    client_pubkey: bytes
    """C, the client's compressed public key."""
    server_pubkey: bytes
    """S, the server's compressed public key (``extra.serverPubKey``)."""
    refund_height: int
    """t, the refund height."""


def is_compressed_pubkey(k: bytes) -> bool:
    """The spec's key form: 33 bytes with prefix 02/03 (uncompressed keys are refused)."""
    return len(k) == 33 and k[0] in (2, 3)


def is_valid_compressed_pubkey(k: bytes) -> bool:
    """A compressed key that is also a point on secp256k1 (required of S in the requirements)."""
    if not is_compressed_pubkey(k):
        return False
    try:
        coincurve.PublicKey(k)
    except ValueError:
        return False
    return True


def _check(p: ChannelScript) -> None:
    if not is_compressed_pubkey(p.client_pubkey):
        raise ValueError("client key must be a compressed secp256k1 key")
    if not is_compressed_pubkey(p.server_pubkey):
        raise ValueError("server key must be a compressed secp256k1 key")
    if p.client_pubkey == p.server_pubkey:
        raise ValueError("client and server keys must differ")
    if not 0 < p.refund_height < LOCKTIME_THRESHOLD:
        raise ValueError(f"refund height must be a block height in (0, {LOCKTIME_THRESHOLD}): {p.refund_height}")


def build_channel_script(p: ChannelScript) -> bytes:
    """Byte for byte ``63 52 21 <C> 21 <S> 52 ae 67 <push(t)> b1 75 21 <C> ac 68``."""
    _check(p)
    return build_script([
        OP.OP_IF, OP.OP_2, p.client_pubkey, p.server_pubkey, OP.OP_2, OP.OP_CHECKMULTISIG,
        OP.OP_ELSE, Num(p.refund_height), OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, p.client_pubkey, OP.OP_CHECKSIG,
        OP.OP_ENDIF,
    ])


def parse_channel_script(rs: bytes) -> ChannelScript | None:
    """Parses exactly the channel script, or None. Checked by rebuilding: any other encoding (a
    non-minimal t push, extra opcodes, an uncompressed key, C = S) is refused."""
    try:
        chunks = parse_script(rs)
    except ValueError:
        return None
    if len(chunks) != 13:
        return None
    c, s, tc = chunks[2].data, chunks[3].data, chunks[7]
    if not c or not s:
        return None
    # t ≤ 16 is pushed as OP_1..OP_16 (CScript << int64), larger t as a CScriptNum.
    if tc.data is None and OP.OP_1 <= tc.op <= OP.OP_16:
        height = tc.op - OP.OP_1 + 1
    elif tc.data and len(tc.data) <= 5:
        height = decode_script_num(tc.data)
    else:
        return None
    if not 0 < height < LOCKTIME_THRESHOLD:
        return None
    parsed = ChannelScript(c, s, height)
    try:
        return parsed if build_channel_script(parsed) == rs else None
    except ValueError:
        return None


def channel_script_pubkey(rs: bytes) -> bytes:
    """The funding output's scriptPubKey: ``a9 14 <HASH160(redeemScript)> 87``."""
    return p2sh_script(hash160(rs))


def channel_address(network: str, rs: bytes) -> str:
    """The channel's P2SH address (``s2…``/``s3…`` on mainnet)."""
    return encode_address(network, "p2sh", hash160(rs))
