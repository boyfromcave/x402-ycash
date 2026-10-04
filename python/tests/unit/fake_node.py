"""An in-memory ycashd for the exact mechanism's unit tests (a port of the TypeScript
test/unit/exact/fakeNode.ts): a UTXO set, a mempool, a tip, and a script verifier that checks P2PKH
signatures with the package's own ZIP-243 code, so a corrupted signature fails rule 9."""

from __future__ import annotations

import os
from decimal import Decimal
from typing import Any

from x402.schemas import PaymentPayload, PaymentRequirements

from x402_ycash.node import NodeCapabilities, RpcError, SendRawTransactionError, VerifyScriptsResult
from x402_ycash.tx import (
    SIGHASH_ALL,
    Tx,
    TxIn,
    TxOut,
    address_to_script,
    encode_address,
    hash160,
    p2pkh_hash,
    p2pkh_script,
    p2pkh_script_sig,
    parse_script,
    parse_tx,
    pubkey_from_priv,
    sighash_v4,
    sign_input,
    txid,
    verify_input_sig,
)
from x402_ycash.tx.transaction import OutPoint

BRANCH_ID = 0x19BD2D2F
NETWORK = "ycash:regtest"


class FakeNode:
    def __init__(self) -> None:
        self.chain = "regtest"
        self.tip = 300
        self.yellowback = False
        self.yed_cents: dict[str, int] = {}
        self.utxos: dict[str, tuple[int, bytes, int]] = {}  # key -> (value, script, height)
        self.txs: dict[str, dict[str, Any]] = {}  # txid -> {hex, height (None = mempool)}
        self.calls: list[str] = []
        self.send_error: RpcError | None = None

    @staticmethod
    def _key(t: str, n: int) -> str:
        return f"{t}:{n}"

    def add_coin(self, value: int, script: bytes, confirmations: int = 6) -> OutPoint:
        t = os.urandom(32).hex()
        self.utxos[self._key(t, 0)] = (value, script, self.tip - confirmations + 1)
        return OutPoint(t, 0)

    def _spent_in_mempool(self, k: str) -> bool:
        for t in self.txs.values():
            if t["height"] is None and any(self._key(i.prevout.txid, i.prevout.vout) == k for i in parse_tx(t["hex"]).vin):
                return True
        return False

    async def get_blockchain_info(self) -> dict[str, Any]:
        self.calls.append("getblockchaininfo")
        return {"chain": self.chain, "blocks": self.tip, "consensus": {"chaintip": "19bd2d2f", "nextblock": "19bd2d2f"}}

    async def get_block_count(self) -> int:
        self.calls.append("getblockcount")
        return self.tip

    async def get_tx_out(self, t: str, n: int, include_mempool: bool) -> dict[str, Any] | None:
        self.calls.append(f"gettxout {str(include_mempool).lower()}")
        k = self._key(t, n)
        u = self.utxos.get(k)
        if u and u[2] <= self.tip:
            if include_mempool and self._spent_in_mempool(k):
                return None
            return _out(u[0], u[1], self.tip - u[2] + 1)
        m = self.txs.get(t)
        if include_mempool and m and m["height"] is None:
            vout = parse_tx(m["hex"]).vout
            if n < len(vout) and not self._spent_in_mempool(k):
                return _out(vout[n].value, vout[n].script_pubkey, 0)
        return None

    async def verify_scripts(self, hex_tx: str) -> VerifyScriptsResult:
        self.calls.append("signrawtransaction")
        tx = parse_tx(hex_tx)
        errors = []
        for i, inp in enumerate(tx.vin):
            def err(msg: str, inp: TxIn = inp) -> None:
                errors.append({"txid": inp.prevout.txid, "vout": inp.prevout.vout, "error": msg})
            u = self.utxos.get(self._key(inp.prevout.txid, inp.prevout.vout))
            if not u:
                err("Input not found or already spent")
                continue
            chunks = parse_script(inp.script_sig)
            sig = chunks[0].data if chunks else None
            pub = chunks[1].data if len(chunks) > 1 else None
            pkh = p2pkh_hash(u[1])
            if not sig or not pub or pkh is None or hash160(pub) != pkh:
                err("Operation not valid with the current stack size")
                continue
            digest = sighash_v4(tx, i, u[1], u[0], sig[-1], BRANCH_ID)
            if not verify_input_sig(sig, digest, pub):
                err("Script evaluated without error but finished with a false/empty top stack element")
        return VerifyScriptsResult(not errors, errors)

    async def send_raw_transaction(self, hex_tx: str) -> str:
        self.calls.append("sendrawtransaction")
        if self.send_error is not None:
            e, self.send_error = self.send_error, None
            raise e
        t = txid(hex_tx)
        self.txs.setdefault(t, {"hex": hex_tx, "height": None})
        return t

    async def capabilities(self) -> NodeCapabilities:
        return NodeCapabilities("v4", "/YcashCpp:4.5.0/", 4050050, self.yellowback, self.chain)

    async def yed_validate_raw_transaction(self, hex_tx: str) -> dict[str, Any]:
        self.calls.append("yed_validaterawtransaction")
        tx = parse_tx(hex_tx)
        yed_in = sum(self.yed_cents.get(self._key(i.prevout.txid, i.prevout.vout), 0) for i in tx.vin)
        return {"valid": yed_in == 0, "verdict": "OK" if yed_in == 0 else "BURNED", "yedIn": yed_in, "burned": yed_in}

    def mine(self, n: int = 1) -> None:
        for _ in range(n):
            self.tip += 1
            for t, m in self.txs.items():
                if m["height"] is not None:
                    continue
                m["height"] = self.tip
                tx = parse_tx(m["hex"])
                for i in tx.vin:
                    self.utxos.pop(self._key(i.prevout.txid, i.prevout.vout), None)
                for n_, o in enumerate(tx.vout):
                    self.utxos[self._key(t, n_)] = (o.value, o.script_pubkey, self.tip)

    def accept_to_mempool(self, hex_tx: str) -> None:
        self.txs[txid(hex_tx)] = {"hex": hex_tx, "height": None}

    @staticmethod
    def send_error_of(code: int, message: str) -> SendRawTransactionError:
        return SendRawTransactionError(RpcError(code, message, "sendrawtransaction"))


def _out(value: int, script: bytes, confirmations: int) -> dict[str, Any]:
    return {"confirmations": confirmations, "value": Decimal(value) / Decimal(10**8), "value_zat": value,
            "scriptPubKey": {"hex": script.hex(), "type": "pubkeyhash"}}


class Key:
    def __init__(self, seed: int) -> None:
        self.priv = bytes([0x11]) + bytes(30) + bytes([seed])
        self.pub = pubkey_from_priv(self.priv)
        self.script = p2pkh_script(hash160(self.pub))
        self.address = encode_address(NETWORK, "p2pkh", hash160(self.pub))


def build_signed(coins: list[tuple[OutPoint, int, bytes]], priv: bytes, outputs: list[TxOut], expiry: int,
                 lock_time: int = 0, hash_type: int = SIGHASH_ALL, mutate: Any = None) -> str:
    tx = Tx(vin=[TxIn(c[0]) for c in coins], vout=outputs, lock_time=lock_time, expiry_height=expiry)
    if mutate:
        mutate(tx)
    pub = pubkey_from_priv(priv)
    for i, (_, value, script) in enumerate(coins):
        tx.vin[i].script_sig = p2pkh_script_sig(sign_input(sighash_v4(tx, i, script, value, hash_type, BRANCH_ID), priv, hash_type), pub)
    return tx.serialize_hex()


def standard_payment(node: FakeNode, payer: Key, pay_to: str, amount: int = 250_000, fee: int = 1_000,
                     coin_value: int = 10_000_000, expiry: int | None = None, hash_type: int = SIGHASH_ALL,
                     extra_outputs: list[TxOut] | None = None, confirmations: int = 6) -> tuple[str, OutPoint]:
    coin = node.add_coin(coin_value, payer.script, confirmations)
    outputs = [TxOut(amount, address_to_script(pay_to, NETWORK)), *(extra_outputs or [])]
    outputs.append(TxOut(coin_value - sum(o.value for o in outputs) - fee, payer.script))
    hex_tx = build_signed([(coin, coin_value, payer.script)], payer.priv, outputs,
                          expiry if expiry is not None else node.tip + 3 + 4, hash_type=hash_type)
    return hex_tx, coin


def requirements(pay_to: str, amount: str = "250000", **extra: Any) -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact", network=NETWORK, asset="YEC", amount=amount, pay_to=pay_to, max_timeout_seconds=300,
        extra={"assetTransferMethod": "transparent", "areFeesSponsored": False,
               "confirmationPolicy": {"confirmations": -1}, **extra},
    )


def payment_payload(req: PaymentRequirements, transaction: str) -> PaymentPayload:
    return PaymentPayload(x402_version=2, accepted=req.model_copy(deep=True), payload={"transaction": transaction})
