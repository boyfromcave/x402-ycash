# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""`exact` YED and the YED close fee across the Falcon height (mirrors the TypeScript
unit/exact/pq.test.ts and unit/batch/yed.falcon.test.ts cases): from F every output a TRANSFER assigns
YED to is a Falcon TX_PQPKH (TOK-PQ), refused by the builder before signing and by the facilitator."""

from __future__ import annotations

from typing import Any

import pytest
from x402.schemas import PaymentRequirements, SupportedKind

from tests.unit.fake_node import NETWORK, FakeNode, Key, build_signed, payment_payload
from x402_ycash.batch import BatchYcashServerScheme
from x402_ycash.batch.server import YED_CLOSE_FLOOR_FALCON, YED_CLOSE_FLOOR_SLH
from x402_ycash.batch.verify import ChainContext
from x402_ycash.channel import DEFAULT_YED_CLOSE_FEE_FALCON
from x402_ycash.exact import ExactYcashFacilitatorScheme
from x402_ycash.exact import constants as C
from x402_ycash.pq import PQKeyId, pqpkh_script
from x402_ycash.store import InMemorySettlementStore
from x402_ycash.tx import OutPoint, TxOut, encode_address, encode_pq_address, hash160
from x402_ycash.yed import Assignment, TokenCoin, TransferRecipient, YecCoin, build_yed_transfer, transfer_op_return_script

payer = Key(1)
FALCON_SPK = pqpkh_script(PQKeyId(2, bytes([0x5A]) * 32))
FALCON_CHANGE = pqpkh_script(PQKeyId(2, bytes([0x6B]) * 32))
FALCON_PAYTO = encode_pq_address(NETWORK, "yedpq", 2, bytes([0x5A]) * 32)
P2PKH_PAYTO = encode_address(NETWORK, "yed", hash160(Key(2).pub))


class FalconNode(FakeNode):
    def __init__(self, falcon_height: int | None) -> None:
        super().__init__()
        self.yellowback = True
        self.falcon_height = falcon_height

    async def yed_get_info(self) -> dict[str, Any]:
        return {"params": {} if self.falcon_height is None else {"pq": {"falconHeight": self.falcon_height}}}


def payment(node: FakeNode, pay_spk: bytes, change_spk: bytes) -> str:
    token = node.add_coin(10_000, payer.script)
    node.yed_cents[f"{token.txid}:0"] = 1_000
    fee_coin = node.add_coin(1_000_000, payer.script)
    outs = [TxOut(10_000, pay_spk), TxOut(10_000, change_spk), TxOut(0, transfer_op_return_script([Assignment(0, 250), Assignment(1, 750)])),
            TxOut(10_000 + 1_000_000 - 10_000 - 10_000 - 30_000, payer.script)]
    return build_signed([(token, 10_000, payer.script), (fee_coin, 1_000_000, payer.script)], payer.priv, outs, node.tip + 7)


def req(pay_to: str) -> PaymentRequirements:
    return PaymentRequirements(scheme="exact", network=NETWORK, asset="YED", amount="250", pay_to=pay_to, max_timeout_seconds=300,
                               extra={"assetTransferMethod": "transparent", "areFeesSponsored": False, "confirmationPolicy": {"confirmations": 1}})


async def verify(node: FakeNode, hex_tx: str, r: PaymentRequirements) -> Any:
    f = ExactYcashFacilitatorScheme(node, settlement_store=InMemorySettlementStore(), yellowback=True, confirmation_timeout=0.5, confirmation_poll=0.05)
    return await f.averify(payment_payload(r, hex_tx), r)


async def test_facilitator_refuses_non_holders_from_f() -> None:
    node = FalconNode(0)
    r = await verify(node, payment(node, Key(2).script, FALCON_CHANGE), req(P2PKH_PAYTO))
    assert r.invalid_reason == C.ERR_YED_HOLDER and "payTo" in (r.invalid_message or "")
    r = await verify(node, payment(node, FALCON_SPK, payer.script), req(FALCON_PAYTO))
    assert r.invalid_reason == C.ERR_YED_HOLDER and "output 1" in (r.invalid_message or "")
    assert (await verify(node, payment(node, FALCON_SPK, FALCON_CHANGE), req(FALCON_PAYTO))).is_valid


async def test_facilitator_refuses_a_falcon_payee_before_f() -> None:
    node = FalconNode(None)  # regtest default: never
    r = await verify(node, payment(node, FALCON_SPK, payer.script), req(FALCON_PAYTO))
    assert r.invalid_reason == C.ERR_YED_HOLDER
    assert (await verify(node, payment(node, Key(2).script, payer.script), req(P2PKH_PAYTO))).is_valid


def test_builder_refuses_non_holders() -> None:
    tokens = [TokenCoin(OutPoint("aa" * 32, 0), 500, 10_000, payer.script)]
    yec = [YecCoin(OutPoint("bb" * 32, 0), 1_000_000, payer.script)]
    with pytest.raises(ValueError, match="recipient 0"):
        build_yed_transfer([TransferRecipient(payer.script, 200)], tokens, yec, FALCON_CHANGE, payer.script, falcon_active=True)
    with pytest.raises(ValueError, match="the YED change"):
        build_yed_transfer([TransferRecipient(FALCON_SPK, 200)], tokens, yec, payer.script, payer.script, falcon_active=True)
    with pytest.raises(ValueError, match="before the Falcon height"):
        build_yed_transfer([TransferRecipient(FALCON_SPK, 200)], tokens, yec, payer.script, payer.script, falcon_active=False)
    assert build_yed_transfer([TransferRecipient(FALCON_SPK, 200)], tokens, yec, FALCON_CHANGE, payer.script, falcon_active=True).change_cents == 300


def offer(server: BatchYcashServerScheme, network: str = NETWORK) -> str:
    base = PaymentRequirements(scheme="batch-settlement", network=network, asset="YED", amount="1", pay_to=FALCON_PAYTO, max_timeout_seconds=300, extra={})
    return str(server.enhance_payment_requirements(base, SupportedKind(x402_version=2, scheme="batch-settlement", network=network), []).extra["closeFee"])


def test_close_fee_follows_the_falcon_height() -> None:
    assert (YED_CLOSE_FLOOR_FALCON, YED_CLOSE_FLOOR_SLH, DEFAULT_YED_CLOSE_FEE_FALCON) == (6_000, 27_000, 2 * YED_CLOSE_FLOOR_FALCON)
    s = BatchYcashServerScheme(FakeNode(), Key(9).priv, max_deposit=1)
    assert offer(s) == "30000"  # regtest, nothing verified yet: no Falcon
    assert offer(s, "ycash:mainnet") == "12000"  # mainnet: Falcon from day one
    s.manager.last_context = ChainContext(1000, 0x6D5B7A31, 1001)
    assert offer(s) == "12000"
    s.manager.last_context = ChainContext(1000, 0x6D5B7A31, 1002)
    assert offer(s) == "30000"
    o = BatchYcashServerScheme(FakeNode(), Key(9).priv, max_deposit=1, yed_close_fee=8_000)
    with pytest.raises(ValueError, match="SLH-DSA close's fee floor"):
        offer(o)
    assert offer(o, "ycash:mainnet") == "8000"
    with pytest.raises(ValueError, match="fee floor 6000"):
        BatchYcashServerScheme(FakeNode(), Key(9).priv, max_deposit=1, yed_close_fee=5_999)
