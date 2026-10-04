"""scriptSig inspection for verification rule 5 and the response's ``payer``."""

from __future__ import annotations

from ..tx import SIGHASH_ALL, ScriptChunk, encode_address, hash160, p2pkh_hash, p2sh_hash, parse_script


def looks_like_signature(b: bytes) -> bool:
    """Whether a push is a DER signature followed by a hash-type byte, by shape alone (BIP66
    framing). Strictness is the node's job (rule 9); this only finds which pushes are signatures."""
    if not 9 <= len(b) <= 73:
        return False
    if b[0] != 0x30 or b[1] != len(b) - 3:
        return False
    r_len = b[3]
    return b[2] == 0x02 and 5 + r_len < len(b) - 1 and b[4 + r_len] == 0x02


def check_sighash_all(script_sig: bytes) -> str | None:
    """Rule 5: every signature in the scriptSig carries SIGHASH_ALL, and there is at least one (an
    unsigned input would let anyone rewrite the outputs). Returns a reason, or None."""
    try:
        chunks = parse_script(script_sig)
    except ValueError:
        return "scriptSig does not parse"
    sigs = [c.data for c in chunks if c.data is not None and looks_like_signature(c.data)]
    if not sigs:
        return "scriptSig carries no signature"
    for s in sigs:
        if s[-1] != SIGHASH_ALL:
            return f"signature hash type {s[-1]:#x} is not SIGHASH_ALL"
    return None


def address_of_script(spk: bytes, network: str) -> str:
    """The address of a P2PKH or P2SH scriptPubKey, or "" for any other script."""
    pkh = p2pkh_hash(spk)
    if pkh is not None:
        return encode_address(network, "p2pkh", pkh)
    sh = p2sh_hash(spk)
    return encode_address(network, "p2sh", sh) if sh is not None else ""


def address_of_script_sig(script_sig: bytes, network: str) -> str:
    """The address a verified scriptSig spends from, for a settle that resumes after the inputs are
    spent: ``<sig> <pubkey>`` is P2PKH, otherwise the last push is a P2SH redeem script."""
    try:
        chunks: list[ScriptChunk] = parse_script(script_sig)
    except ValueError:
        return ""
    last = chunks[-1].data if chunks else None
    if not last:
        return ""
    is_pubkey = (len(last) == 33 and last[0] in (2, 3)) or (len(last) == 65 and last[0] == 4)
    first = chunks[0].data
    if len(chunks) == 2 and is_pubkey and first is not None and looks_like_signature(first):
        return encode_address(network, "p2pkh", hash160(last))
    return encode_address(network, "p2sh", hash160(last))
