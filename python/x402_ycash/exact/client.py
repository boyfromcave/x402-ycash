"""A minimal exact client for ``transparent`` YEC: build and sign the payment transaction a
facilitator verifies (spec "Transaction Construction"). Backends mostly run the facilitator and the
server; this exists for agents written in Python and for interop tests against the TypeScript
facilitator. It never broadcasts."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from x402.schemas import PaymentRequirements

from .._sync import run_sync
from ..constants import DUST_ZAT
from ..node import yec_to_zat
from ..tx import (
    OutPoint,
    Tx,
    TxIn,
    TxOut,
    address_to_script,
    encode_address,
    fee_floor,
    hash160,
    p2pkh_script,
    p2pkh_script_sig,
    pubkey_from_priv,
    sighash_v4,
    sign_input,
)
from .constants import SCHEME_EXACT
from .policy import check_transparent_method, check_transparent_yec_requirements, client_expiry_height


@dataclass(frozen=True)
class Utxo:
    outpoint: OutPoint
    value: int
    """zatoshi"""


def build_exact_payment(
    requirements: PaymentRequirements,
    utxos: Sequence[Utxo],
    priv_key: bytes,
    tip: int,
    branch_id: int,
) -> Tx:
    """A signed v4 transaction paying ``requirements`` from P2PKH coins of ``priv_key``: one output of
    exactly ``amount`` to ``payTo``, change back to the key's address (dropped when below dust), the
    S-6 fee floor, SIGHASH_ALL, nLockTime 0, nExpiryHeight = tip + 3 + ⌈maxTimeoutSeconds / 75⌉.
    Coins are taken largest first until they cover amount and fee."""
    bad = check_transparent_yec_requirements(requirements.network, requirements.asset, requirements.amount,
                                             requirements.pay_to, requirements.max_timeout_seconds)
    bad = bad or (check_transparent_method(requirements.extra) or (None, None))[1]
    if bad:
        raise ValueError(bad)
    amount = int(requirements.amount)
    pub = pubkey_from_priv(priv_key)
    own_script = p2pkh_script(hash160(pub))
    tx = Tx(vout=[TxOut(amount, address_to_script(requirements.pay_to, requirements.network))],
            expiry_height=client_expiry_height(tip, requirements.max_timeout_seconds))
    selected: list[Utxo] = []
    for u in sorted(utxos, key=lambda u: u.value, reverse=True):
        selected.append(u)
        tx.vin = [TxIn(s.outpoint, bytes(107)) for s in selected]  # a P2PKH scriptSig's size, for the fee
        with_change = Tx(vin=tx.vin, vout=[*tx.vout, TxOut(0, own_script)])
        total = sum(s.value for s in selected)
        if total >= amount + fee_floor(with_change):
            change = total - amount - fee_floor(with_change)
            if change >= DUST_ZAT:
                tx.vout.append(TxOut(change, own_script))
            break
    else:
        raise ValueError(f"coins of {sum(u.value for u in utxos)} zat do not cover {amount} zat and the fee")
    for i, s in enumerate(selected):
        sh = sighash_v4(tx, i, own_script, s.value, 0x01, branch_id)
        tx.vin[i].script_sig = p2pkh_script_sig(sign_input(sh, priv_key), pub)
    return tx


class ExactYcashClientScheme:
    """``SchemeNetworkClient`` for ``transparent`` YEC, signing with a local key and reading coins,
    tip and branch id from a node (``listunspent`` needs the key's address watched by the node)."""

    scheme = SCHEME_EXACT

    def __init__(self, rpc: Any, priv_key: bytes) -> None:
        self._rpc = rpc
        self._priv = priv_key

    def address(self, network: str) -> str:
        return encode_address(network, "p2pkh", hash160(pubkey_from_priv(self._priv)))

    def create_payment_payload(self, requirements: PaymentRequirements) -> dict[str, Any]:
        return run_sync(self.acreate_payment_payload(requirements))

    async def acreate_payment_payload(self, requirements: PaymentRequirements) -> dict[str, Any]:
        info = await self._rpc.get_blockchain_info()
        branch = int(info["consensus"]["nextblock"], 16)
        unspent = await self._rpc.list_unspent(1, 9_999_999, [self.address(requirements.network)])
        utxos = [Utxo(OutPoint(u["txid"], u["vout"]), yec_to_zat(u["amount"])) for u in unspent]
        tx = build_exact_payment(requirements, utxos, self._priv, int(info["blocks"]), branch)
        return {"transaction": tx.serialize_hex()}
