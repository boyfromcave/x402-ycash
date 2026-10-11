# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""The hybrid post-quantum channel TX_PQCHANNEL (quantum spec header, D-Q-19; the node's
GetScriptForPQChannel / MatchPQChannel), a bare output. Mirrors packages/ycash/src/channel/pqScript.ts.

    OP_IF   <clientHash:32> OP_1|OP_2 OP_CHECKPQSIG OP_VERIFY <serverKey:33> OP_CHECKSIG
    OP_ELSE <refundHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <clientHash:32> OP_1|OP_2 OP_CHECKPQSIG
    OP_ENDIF

``63 20<h> 5n c2 69 21<pk> ac 67 <num> b1 75 20<h> 5n c2 68``, 112–117 bytes. Both client slots
byte-identical, the server key a valid compressed secp256k1 point, refundHeight a minimal positive
CScriptNum below 500,000,000.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..pq import PQKeyId, is_known_scheme
from ..tx import OP, Num, build_script, decode_script_num, parse_script
from .script import LOCKTIME_THRESHOLD, is_valid_compressed_pubkey

PQ_CHANNEL_SCRIPT_MIN = 112
PQ_CHANNEL_SCRIPT_MAX = 117


@dataclass(frozen=True)
class PQChannelScript:
    client: PQKeyId
    server_pubkey: bytes
    refund_height: int


def build_pq_channel_script(p: PQChannelScript) -> bytes:
    """Byte for byte the node's GetScriptForPQChannel; raises ValueError on a broken field rule."""
    if not is_known_scheme(p.client.scheme):
        raise ValueError(f"unknown post-quantum scheme {p.client.scheme}")
    if len(p.client.hash) != 32:
        raise ValueError("the client key hash must be 32 bytes")
    if not is_valid_compressed_pubkey(p.server_pubkey):
        raise ValueError("server key must be a valid compressed secp256k1 key")
    if not 0 < p.refund_height < LOCKTIME_THRESHOLD:
        raise ValueError(f"refund height must be a block height in (0, {LOCKTIME_THRESHOLD}): {p.refund_height}")
    scheme_op = int(OP.OP_1) + p.client.scheme - 1
    return build_script([
        OP.OP_IF, p.client.hash, scheme_op, OP.OP_CHECKPQSIG, OP.OP_VERIFY, p.server_pubkey, OP.OP_CHECKSIG,
        OP.OP_ELSE, Num(p.refund_height), OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP, p.client.hash, scheme_op, OP.OP_CHECKPQSIG,
        OP.OP_ENDIF,
    ])


def parse_pq_channel_script(spk: bytes) -> PQChannelScript | None:
    """The node's MatchPQChannel: decode the fields by token, then require the rebuilt script byte for byte."""
    if not PQ_CHANNEL_SCRIPT_MIN <= len(spk) <= PQ_CHANNEL_SCRIPT_MAX or spk[0] != OP.OP_IF or spk[-1] != OP.OP_ENDIF:
        return None
    try:
        chunks = parse_script(spk)
    except ValueError:
        return None
    if len(chunks) != 15:
        return None
    h, server, scheme_op, tc = chunks[1].data, chunks[5].data, chunks[2], chunks[8]
    if h is None or len(h) != 32 or server is None or len(server) != 33:
        return None
    if scheme_op.data is not None or scheme_op.op not in (OP.OP_1, OP.OP_2):
        return None
    if tc.data is None and OP.OP_1 <= tc.op <= OP.OP_16:
        height = tc.op - OP.OP_1 + 1
    elif tc.data and len(tc.data) <= 5:
        height = decode_script_num(tc.data)
    else:
        return None
    if not 0 < height < LOCKTIME_THRESHOLD:
        return None
    parsed = PQChannelScript(PQKeyId(scheme_op.op - OP.OP_1 + 1, h), server, height)
    try:
        return parsed if build_pq_channel_script(parsed) == spk else None
    except ValueError:
        return None


def is_pq_channel_script(spk: bytes) -> bool:
    return parse_pq_channel_script(spk) is not None
