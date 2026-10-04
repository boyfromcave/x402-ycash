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
from x402_ycash.yed import FoundPayload, find_payload, validate_transfer_assignments

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
        self.unconfirmed_tokens: set[str] = set()  # token outpoints the overlay cannot see yet (X-F14)
        self.z_notes: dict[str, list[dict[str, Any]]] = {}  # address -> z_listreceivedbyaddress entries
        self.issued: list[str] = []

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
        return self._verify(hex_tx)

    def _prevout(self, k: str) -> tuple[int, bytes, int] | None:
        """A coin in the UTXO set, or an output of a mempool tx (signrawtransaction sees both)."""
        u = self.utxos.get(k)
        if u:
            return u
        t, _, n = k.partition(":")
        m = self.txs.get(t)
        if m and m["height"] is None:
            vout = parse_tx(m["hex"]).vout
            if int(n) < len(vout):
                return (vout[int(n)].value, vout[int(n)].script_pubkey, self.tip + 1)
        return None

    def _verify(self, hex_tx: str) -> VerifyScriptsResult:
        from x402_ycash.channel import parse_channel_script, parse_close_script_sig
        from x402_ycash.tx import p2sh_hash

        tx = parse_tx(hex_tx)
        errors = []
        for i, inp in enumerate(tx.vin):
            def err(msg: str, inp: TxIn = inp) -> None:
                errors.append({"txid": inp.prevout.txid, "vout": inp.prevout.vout, "error": msg})
            u = self._prevout(self._key(inp.prevout.txid, inp.prevout.vout))
            if not u:
                err("Input not found or already spent")
                continue
            if p2sh_hash(u[1]) is not None:  # a channel close: both signatures over the redeem script
                ss = parse_close_script_sig(inp.script_sig)
                cs = parse_channel_script(ss.redeem_script) if ss else None
                if ss is None or cs is None or hash160(ss.redeem_script) != p2sh_hash(u[1]) or not ss.sig_s:
                    err("Operation not valid with the current stack size")
                    continue
                digest = sighash_v4(tx, i, ss.redeem_script, u[0], SIGHASH_ALL, BRANCH_ID)
                if not (verify_input_sig(ss.sig_c, digest, cs.client_pubkey) and verify_input_sig(ss.sig_s, digest, cs.server_pubkey)):
                    err("Script evaluated without error but finished with a false/empty top stack element")
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

    def _overlay(self, hex_tx: str) -> dict[str, Any]:
        """The overlay's verdict as both lines compute it, for the cases the tests exercise: a TRANSFER
        whose assignments register and cover yedIn is ok; anything else burns every input cent."""
        tx = parse_tx(hex_tx)
        keys = [self._key(i.prevout.txid, i.prevout.vout) for i in tx.vin]
        yed_in = sum(self.yed_cents.get(k, 0) for k in keys)
        found = find_payload([o.script_pubkey for o in tx.vout])
        typ, yed_out = "none", 0
        if isinstance(found, FoundPayload) and found.payload.type == "transfer":
            typ = "transfer"
            a = found.payload.assignments
            if validate_transfer_assignments(a, len(tx.vout), found.index, yed_in).valid:
                yed_out = yed_in
        burned = yed_in - yed_out
        return {"valid": not self._verify(hex_tx).errors, "verdict": "burned" if burned else "ok", "type": typ,
                "yedIn": yed_in, "yedOut": yed_out, "burned": burned,
                "unconfirmedInputs": [{"txid": k.split(":")[0], "vout": int(k.split(":")[1])} for k in keys if k in self.unconfirmed_tokens]}

    async def yed_validate_raw_transaction(self, hex_tx: str) -> dict[str, Any]:
        self._need_overlay("yed_validaterawtransaction")
        return self._overlay(hex_tx)

    async def yed_decode_payload(self, hex_tx: str) -> dict[str, Any]:
        self._need_overlay("yed_decodepayload")
        tx = parse_tx(hex_tx)
        found = find_payload([o.script_pubkey for o in tx.vout])
        if not isinstance(found, FoundPayload):
            return {"valid": False, "version": 3, "type": "none"}
        return {"valid": True, "version": 3, **found.payload.to_json(), "opReturnIndex": found.index}

    def _need_overlay(self, method: str) -> None:
        self.calls.append(method)
        if not self.yellowback:
            raise RpcError(-32601, "Method not found", method)

    async def yed_get_price(self, height: int | None = None) -> dict[str, Any]:
        self._need_overlay("yed_getprice")
        return {"height": self.tip, "pFast": None, "pMid": 50_000_000, "pSlow": None}

    async def z_get_new_address(self) -> str:
        return encode_sapling(NETWORK, 0)

    async def z_get_new_diversified_address(self, base: str) -> str:
        assert base == encode_sapling(NETWORK, 0)
        a = encode_sapling(NETWORK, len(self.issued) + 1)
        self.issued.append(a)
        return a

    async def z_list_received_by_address(self, address: str, minconf: int = 1) -> list[dict[str, Any]]:
        self.calls.append("z_listreceivedbyaddress")
        if getattr(self, "viewing_key_only", False) and address not in self.z_notes:
            # A viewing-key-only wallet refuses an address it has decrypted no note at (both lines).
            raise RpcError(-5, "From address does not belong to this node, zaddr spending key or viewing key not found.", "z_listreceivedbyaddress")
        return [n for n in self.z_notes.get(address, []) if n.get("confirmations", 0) >= minconf]

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
                overlay = self._overlay(m["hex"]) if self.yellowback else None
                for i in tx.vin:
                    self.yed_cents.pop(self._key(i.prevout.txid, i.prevout.vout), None)
                for n_, o in enumerate(tx.vout):
                    self.utxos[self._key(t, n_)] = (o.value, o.script_pubkey, self.tip)
                if overlay and overlay["type"] == "transfer" and overlay["verdict"] == "ok":
                    found = find_payload([o.script_pubkey for o in tx.vout])
                    assert isinstance(found, FoundPayload)
                    for a in found.payload.assignments:
                        self.yed_cents[self._key(t, a.vout)] = a.cents

    def accept_to_mempool(self, hex_tx: str) -> None:
        self.txs[txid(hex_tx)] = {"hex": hex_tx, "height": None}

    @staticmethod
    def send_error_of(code: int, message: str) -> SendRawTransactionError:
        return SendRawTransactionError(RpcError(code, message, "sendrawtransaction"))


def encode_sapling(network: str, n: int) -> str:
    """A stand-in Sapling address with the network's HRP (the facilitator compares strings only)."""
    hrp = {"ycash:regtest": "yregtestsapling", "ycash:testnet": "ytestsapling", "ycash:mainnet": "ys"}[network]
    return f"{hrp}1{n:0>70}"


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
