"""The Vault network upgrade (branch id 0x6d5b7a31, after Canopy) for the signers and verifiers.

Nothing here carries an upgrade table: every signer and verifier takes the branch id from the
node's ``getblockchaininfo.consensus.nextblock`` (batch ``chain_context``, the exact client). So
past Vault's activation a voucher is signed and checked under 0x6d5b7a31, and one signed under
Canopy no longer verifies. On the block before activation ``nextblock`` already says Vault while
``chaintip`` still says Canopy, which is why the chaintip is never used.
"""

import asyncio

from tests.conftest import load_vector
from x402_ycash.batch.verify import chain_context
from x402_ycash.channel import (
    Channel,
    ChannelScript,
    build_channel_script,
    build_voucher,
    verify_voucher_signature,
    voucher_sighash,
)
from x402_ycash.tx import SIGHASH_ALL, OutPoint, address_to_script, parse_tx, pubkey_from_priv, sighash_v4

CANOPY = 0x19BD2D2F
VAULT = 0x6D5B7A31

DOC = load_vector("channel/channel_yec.json")
CH = DOC["channel"]
C_PRIV, S_PRIV = bytes.fromhex(CH["clientPriv"]), bytes.fromhex(CH["serverPriv"])
RS = build_channel_script(ChannelScript(pubkey_from_priv(C_PRIV), pubkey_from_priv(S_PRIV), CH["refundHeight"]))
CHANNEL = Channel.from_script(OutPoint(CH["outpoint"]["txid"], CH["outpoint"]["vout"]), RS, int(CH["value"]),
                              int(CH["closeFee"]), address_to_script(CH["payTo"], "ycash:regtest"))
CLIENT_SCRIPT = bytes.fromhex(CH["clientScript"])


class _Chain:
    def __init__(self, tip: int, chaintip: str, nextblock: str):
        self.info = {"chain": "regtest", "blocks": tip, "consensus": {"chaintip": chaintip, "nextblock": nextblock}}

    async def get_blockchain_info(self):
        return self.info


def test_the_canopy_vectors_stay_canopy():
    assert int(DOC["branchId"], 16) == CANOPY


def test_vault_sighash_differs_from_canopy():
    v = DOC["vouchers"][0]
    tx = parse_tx(v["voucher"])
    canopy = voucher_sighash(tx, CHANNEL, CANOPY)
    assert canopy.hex() == v["sighash"]
    vault = voucher_sighash(tx, CHANNEL, VAULT)
    assert vault != canopy
    # Only the personalisation's last four bytes (the branch id, little-endian) change.
    assert vault == sighash_v4(tx, 0, RS, CHANNEL.value, SIGHASH_ALL, VAULT)


def test_a_verifier_at_vault_accepts_a_vault_voucher_and_refuses_a_canopy_one():
    v = DOC["vouchers"][0]
    # Block 102 is the tip; Vault activates at 103 (the wt/up-dd devnet's -nuparams=6d5b7a31:103).
    ctx = asyncio.run(chain_context(_Chain(102, "19bd2d2f", "6d5b7a31"), "ycash:regtest"))
    assert (ctx.tip, ctx.branch_id) == (102, VAULT)
    vault_voucher = build_voucher(CHANNEL, int(v["cumulative"]), C_PRIV, ctx.branch_id, CLIENT_SCRIPT)
    canopy_voucher = parse_tx(v["voucher"])
    assert verify_voucher_signature(vault_voucher, CHANNEL, ctx.branch_id)
    assert not verify_voucher_signature(canopy_voucher, CHANNEL, ctx.branch_id)
    # The block before (tip 101, next block 102 still Canopy): the Canopy voucher is the valid one.
    before = asyncio.run(chain_context(_Chain(101, "19bd2d2f", "19bd2d2f"), "ycash:regtest"))
    assert verify_voucher_signature(canopy_voucher, CHANNEL, before.branch_id)
    assert not verify_voucher_signature(vault_voucher, CHANNEL, before.branch_id)
