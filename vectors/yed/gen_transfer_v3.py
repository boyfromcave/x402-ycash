#!/usr/bin/env python3
# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""Generate vectors/yed/transfer_v3.json from the node's own qa framework.

The Yellowback payload codec of record is ycash-dd/src/yellowback/payload.cpp; its Python twin
is ycash-dd/qa/rpc-tests/test_framework (encode_transfer_v3 in yellowback_attest.py, decode_payload
and tx_payload in yellowback_model.py). Every expected value below comes from those functions, so
any port that reproduces this file agrees with the node's test framework.

Run from the yellowback workspace root, with the workspace venv:

    .venv/bin/python wt/x402-specs/vectors/yed/gen_transfer_v3.py ycash-dd > .../transfer_v3.json
"""
import json
import struct
import subprocess
import sys

ycash_dd = sys.argv[1] if len(sys.argv) > 1 else 'ycash-dd'
sys.path.insert(0, ycash_dd + '/qa/rpc-tests')

from test_framework import yellowback_attest as ya  # noqa: E402
from test_framework import yellowback_model as ym  # noqa: E402

NAMES = {0x01: 'mint', 0x02: 'transfer', 0x03: 'redeem', 0x05: 'register', 0x06: 'notice',
         0x07: 'equivocation', 0x08: 'revive'}  # PayloadTypeName, payload.cpp:432-444

P2PKH = bytes.fromhex('76a914' + '11' * 20 + '88ac')
P2SH = bytes.fromhex('a914' + '22' * 20 + '87')
KEY_A = bytes.fromhex('02' + '33' * 32)
KEY_B = bytes.fromhex('03' + '44' * 32)


def described(p):
    """The decoded payload as JSON, field names as in the TypeScript codec."""
    if p is None:
        return None
    out = {'type': NAMES[p.type]}
    if p.type == ym.PAYLOAD_TRANSFER:
        out['assignments'] = [{'vout': v, 'cents': c} for v, c in p.assignments]
    elif p.type == ym.PAYLOAD_REDEEM:
        out.update(refHeight=p.ref_height, feeVout=p.fee_vout, attestFeeVout=p.attest_fee_vout,
                   assignments=[{'vout': v, 'cents': c} for v, c in p.assignments])
    elif p.type == ym.PAYLOAD_MINT:
        out.update(termClass=p.term_class, cents=p.cents, lockHeight=p.lock_height, refHeight=p.ref_height,
                   ownerKey=p.owner_pubkey.hex(), feeVout=p.fee_vout, attestFeeVout=p.attest_fee_vout)
    elif p.type == ym.PAYLOAD_ATTESTOR_REGISTER:
        out.update(attestorKey=p.attestor_pubkey.hex(), bondKey=p.bond_pubkey.hex(),
                   bondLocktime=p.bond_locktime, flags=p.flags)
    elif p.type == ym.PAYLOAD_CLAIM_NOTICE:
        out.update(vaultTxid=p.vault_txid, vaultVout=p.vault_vout, refHeight=p.ref_height)
    elif p.type == ym.PAYLOAD_ATTESTOR_REVIVE:
        out.update(seq=p.seq, priceMicroUsd=p.price_micro_usd, citedHeight=p.cited_height, sig=p.sig.hex())
    return out


def header(version, type_):
    return ym.PAYLOAD_MAGIC + bytes([version, type_])


def raw_transfer(count, pairs):
    """A TRANSFER body with an arbitrary count byte (for malformed cases the encoder refuses)."""
    out = header(3, 0x02) + bytes([count])
    for v, c in pairs:
        out += bytes([v]) + struct.pack('<I', c)
    return out


encode_cases = [
    ('one output at $1.00', [(0, 100)]),
    ('server and client of a channel voucher', [(0, 1234), (1, 766)]),
    ('vouts out of order are kept in order', [(3, 100), (1, 200)]),
    ('XFER-1 maximum, $100,000', [(1, 10000000)]),
    ('u32 maximum: encodable, burns under XFER-1', [(0, 0xFFFFFFFF)]),
    ('vout 255', [(255, 500)]),
    ('zero assignments: encodable, burns every YED input', []),
    ('14 assignments, 75 bytes: the largest direct push', [(i, 100 + i) for i in range(14)]),
    ('15 assignments, 80 bytes: OP_PUSHDATA1', [(i, 100 + i) for i in range(15)]),
]
encode = []
for name, pairs in encode_cases:
    data = ya.encode_transfer_v3(pairs)
    encode.append({'name': name, 'assignments': [{'vout': v, 'cents': c} for v, c in pairs],
                   'data': data.hex(), 'script': (bytes([ym.OP_RETURN]) + ym.push(data)).hex()})

good_transfer = ya.encode_transfer_v3([(0, 100), (2, 250)])
decode_cases = [(e['name'], bytes.fromhex(e['data'])) for e in encode]
decode_cases += [
    ('mint', ya.encode_mint_v3(1, 25000, 900000, 812345, KEY_A, 2, 3)),
    ('mint without fee outputs', ya.encode_mint_v3(0, 10000, 1, 2, KEY_A, ym.FEE_VOUT_NONE)),
    ('redeem', ya.encode_redeem_v3(812000, 1, ym.FEE_VOUT_NONE, [(0, 5000), (2, 100)])),
    ('attestor register', ya.encode_attestor_register(KEY_A, KEY_B, 830000, 1)),
    ('claim notice', ya.encode_claim_notice('ab' * 31 + 'cd', 4, 812999)),
    ('equivocation', ya.encode_equivocation()),
    ('attestor revive', ya.encode_revive(struct.pack('<HII', 7, 1234567, 812400) + bytes(range(64)))),
    ('too short: 3 bytes', b'YB\x03'),
    ('too long: 81 bytes', good_transfer + b'\x00' * (81 - len(good_transfer))),
    ('bad magic', b'YC' + good_transfer[2:]),
    ('version 2 is non-Yellowback (V23)', header(2, 0x02) + good_transfer[4:]),
    ('version 4 is non-Yellowback', header(4, 0x02) + good_transfer[4:]),
    ('reserved type 0x04', header(3, 0x04) + good_transfer[4:]),
    ('reserved type 0x10 (retired PRICE)', header(3, 0x10) + good_transfer[4:]),
    ('transfer: count 2, one assignment', raw_transfer(2, [(0, 100)])),
    ('transfer: trailing byte', good_transfer + b'\x00'),
    ('transfer: header only, no count', header(3, 0x02)),
    ('transfer: zero cents', raw_transfer(2, [(0, 100), (1, 0)])),
    ('transfer: duplicate vout', raw_transfer(2, [(1, 100), (1, 200)])),
    ('redeem: zero cents', ya.encode_redeem_v3(1, 1, 1, [(0, 0)])),
    ('mint: one byte short', ya.encode_mint_v3(1, 25000, 1, 2, KEY_A, 2)[:-1]),
    ('equivocation: trailing byte', ya.encode_equivocation() + b'\x00'),
]
decode = [{'name': n, 'data': d.hex(), 'payload': described(ym.decode_payload(d))} for n, d in decode_cases]


def opret(data):
    return bytes([ym.OP_RETURN]) + ym.push(data)


def push_n(op, data):
    """OP_RETURN with a deliberately non-minimal push opcode (accepted by GetOp)."""
    size = {0x4c: bytes([len(data)]), 0x4d: struct.pack('<H', len(data)), 0x4e: struct.pack('<I', len(data))}[op]
    return bytes([ym.OP_RETURN, op]) + size + data


small = ya.encode_transfer_v3([(0, 100), (1, 200)])
find_cases = [
    ('OP_RETURN last, assigns 0 and 1', [P2PKH, P2SH, opret(small)]),
    ('OP_RETURN first, assigns 1 and 2', [opret(ya.encode_transfer_v3([(1, 100), (2, 200)])), P2PKH, P2SH]),
    ('no OP_RETURN', [P2PKH, P2SH]),
    ('two OP_RETURNs', [P2PKH, P2SH, opret(small), opret(small)]),
    ('assigns the OP_RETURN itself', [P2PKH, opret(small), P2SH]),
    ('assigned vout does not exist', [P2PKH, opret(ya.encode_transfer_v3([(0, 100), (2, 200)]))]),
    ('non-minimal OP_PUSHDATA1 is accepted', [P2PKH, P2SH, push_n(0x4c, small)]),
    ('OP_PUSHDATA2 is accepted', [P2PKH, P2SH, push_n(0x4d, small)]),
    ('OP_PUSHDATA4 is accepted', [P2PKH, P2SH, push_n(0x4e, small)]),
    ('two pushes after OP_RETURN', [P2PKH, P2SH, opret(small) + ym.push(b'\x01')]),
    ('bare OP_RETURN', [P2PKH, P2SH, bytes([ym.OP_RETURN])]),
    ('OP_RETURN OP_0', [P2PKH, P2SH, bytes([ym.OP_RETURN, 0x00])]),
    ('OP_RETURN OP_1', [P2PKH, P2SH, bytes([ym.OP_RETURN, 0x51])]),
    ('truncated push', [P2PKH, P2SH, opret(small)[:-1]]),
    ('push of 3 bytes', [P2PKH, P2SH, opret(b'YB\x03')]),
    ('unknown payload version', [P2PKH, P2SH, opret(header(4, 0x02) + small[4:])]),
    ('a mint payload is found (type named)', [P2SH, opret(ya.encode_mint_v3(1, 25000, 9, 8, KEY_A, 0)), P2PKH]),
]
find = []
for name, scripts in find_cases:
    p, idx = ym.tx_payload(scripts)
    find.append({'name': name, 'outputs': [s.hex() for s in scripts],
                 'opReturnIndex': idx, 'payload': described(p)})

commit = subprocess.run(['git', '-C', ycash_dd, 'rev-parse', '--short=9', 'HEAD'],
                        capture_output=True, text=True).stdout.strip()
json.dump({
    'description': 'Yellowback payload v3 vectors: TRANSFER encoding, decoding of every type, and '
                   'FindPayload over output scripts. A null payload means non-Yellowback.',
    'source': 'ycash-dd qa/rpc-tests/test_framework (encode_transfer_v3, decode_payload, tx_payload) '
              'at ' + commit + ', generated by vectors/yed/gen_transfer_v3.py',
    'encode': encode,
    'decode': decode,
    'find': find,
}, sys.stdout, indent=2)
sys.stdout.write('\n')
