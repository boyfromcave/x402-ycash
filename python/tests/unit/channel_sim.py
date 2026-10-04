"""A minimal channel client for the batch-settlement unit tests: it funds a channel from a fake coin and
signs vouchers with the package's channel builders, as the TypeScript BatchYcashClientScheme does. Every
voucher returns the remainder to the funder's wallet address (``return_address``), never to C."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from x402.schemas import PaymentPayload, PaymentRequirements

from tests.unit.fake_node import BRANCH_ID, NETWORK, FakeNode, Key
from x402_ycash.channel import (
    Channel,
    ChannelScript,
    FundingInput,
    build_channel_script,
    build_funding_tx,
    build_voucher,
    build_yed_funding_tx,
    channel_id_of,
    sign_funding_tx,
    yec_voucher_outputs,
    yed_channel_value,
    yed_voucher_layout,
)
from x402_ycash.tx import OutPoint, address_to_script, encode_address, hash160, txid
from x402_ycash.yed import TokenCoin, YecCoin


def batch_requirements(server_pub: bytes, pay_to: str, amount: str = "1000", asset: str = "YEC", confirmations: int = 1,
                       max_deposit: str = "100000000", close_fee: str = "1500") -> PaymentRequirements:
    return PaymentRequirements(scheme="batch-settlement", network=NETWORK, asset=asset, amount=amount, pay_to=pay_to,
                               max_timeout_seconds=300,
                               extra={"serverPubKey": server_pub.hex(), "minLockBlocks": 30, "closeMarginBlocks": 5,
                                      "maxDeposit": max_deposit, "closeFee": close_fee, "areFeesSponsored": False,
                                      "confirmationPolicy": {"confirmations": confirmations}})


def wrap(req: PaymentRequirements, payload: dict[str, Any]) -> PaymentPayload:
    return PaymentPayload(x402_version=2, accepted=req.model_copy(deep=True), payload=payload)


@dataclass
class ClientSim:
    node: FakeNode
    req: PaymentRequirements
    deposit: int
    """D: zatoshis (YEC) or cents (YED)."""
    lock_blocks: int = 40
    key: Key = field(default_factory=lambda: Key(7))
    """C, the channel key."""
    wallet: Key = field(default_factory=lambda: Key(8))
    """The funder's wallet: it funds the channel and gets the remainder back."""
    return_address: str = ""
    """The open's returnAddress; default the wallet's (``yr…`` for YED, ``sm…`` for YEC)."""
    expiry_height: int = 0
    """The funding's nExpiryHeight (0: never)."""
    channel: Channel | None = None
    funding_hex: str = ""

    def __post_init__(self) -> None:
        if not self.return_address:
            self.return_address = encode_address(NETWORK, "yed" if self.yed else "p2pkh", hash160(self.wallet.pub))

    @property
    def return_script(self) -> bytes:
        return address_to_script(self.return_address, NETWORK)

    @property
    def yed(self) -> bool:
        return self.req.asset == "YED"

    def fund(self) -> None:
        """Builds and signs the funding transaction (not broadcast: the server relays it at open)."""
        close_fee = int(self.req.extra["closeFee"])
        rs = build_channel_script(ChannelScript(self.key.pub, bytes.fromhex(self.req.extra["serverPubKey"]), self.node.tip + self.lock_blocks))
        w = self.wallet
        if self.yed:
            token = self.node.add_coin(10_000, w.script)
            self.node.yed_cents[f"{token.txid}:0"] = self.deposit + 500
            coin = self.node.add_coin(1_000_000, w.script)
            built = build_yed_funding_tx(rs, self.deposit, close_fee, [TokenCoin(token, self.deposit + 500, 10_000, w.script)],
                                         [YecCoin(coin, 1_000_000, w.script)], w.script, w.script, self.expiry_height)
            signed = sign_funding_tx(built.tx, built.inputs, [w.priv] * len(built.inputs), BRANCH_ID)
            value = yed_channel_value(close_fee)
        else:
            value = self.deposit + close_fee
            coin = self.node.add_coin(value + 100_000, w.script)
            inputs = [FundingInput(coin, value + 100_000, w.script)]
            tx = build_funding_tx(inputs, rs, value, w.script, expiry_height=self.expiry_height)
            signed = sign_funding_tx(tx, inputs, [w.priv], BRANCH_ID)
        self.funding_hex = signed.serialize_hex()
        self.channel = Channel.from_script(OutPoint(txid(signed), 0), rs, value, close_fee, address_to_script(self.req.pay_to, NETWORK))

    @property
    def channel_id(self) -> str:
        assert self.channel is not None
        return channel_id_of(self.channel.outpoint)

    def voucher_hex(self, cumulative: int, layout: Any = None, to: bytes | None = None) -> str:
        """A voucher signed by C, its client output paying the return address (or ``to``)."""
        assert self.channel is not None
        layout = layout or (yed_voucher_layout(self.deposit) if self.yed else yec_voucher_outputs)
        return build_voucher(self.channel, cumulative, self.key.priv, BRANCH_ID, to or self.return_script, layout).serialize_hex()

    def open(self, cumulative: int, req: PaymentRequirements | None = None) -> PaymentPayload:
        if self.channel is None:
            self.fund()
        assert self.channel is not None
        return wrap(req or self.req, {"type": "open", "fundingTx": self.funding_hex, "vout": 0, "redeemScript": self.channel.redeem_script.hex(),
                                      "returnAddress": self.return_address,
                                      "voucher": {"tx": self.voucher_hex(cumulative), "cumulative": str(cumulative)}})

    def voucher(self, cumulative: int, kind: str = "voucher", req: PaymentRequirements | None = None, tx: str | None = None) -> PaymentPayload:
        return wrap(req or self.req, {"type": kind, "channelId": self.channel_id, "tx": tx or self.voucher_hex(cumulative),
                                      "cumulative": str(cumulative)})
