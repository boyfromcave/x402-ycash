"""Network ids, assets and protocol constants (plan X-3, X-4), mirroring packages/ycash/src/constants.ts.

Ycash's genesis blocks are Zcash's, so the network id is a named namespace, following Cardano's
unregistered ``cardano:mainnet`` form.
"""

from __future__ import annotations

YCASH_MAINNET = "ycash:mainnet"
YCASH_TESTNET = "ycash:testnet"
YCASH_REGTEST = "ycash:regtest"
YCASH_NETWORKS: tuple[str, ...] = (YCASH_MAINNET, YCASH_TESTNET, YCASH_REGTEST)
YCASH_CAIP_FAMILY = "ycash:*"

ASSET_YEC = "YEC"
"""Counts zatoshis (1e-8 YEC)."""
ASSET_YED = "YED"
"""Counts cents."""

BLOCK_SECONDS = 75
"""Target block spacing after Blossom, seconds."""
TX_EXPIRING_SOON_THRESHOLD = 3
"""A tx whose nExpiryHeight is below next + 3 is refused at relay (ycash-dd/src/main.h:81, ycash6 :105)."""
YED_MIN_OUTPUT_CENTS = 100
"""Overlay XFER-1 (ycash-dd/src/yellowback/params.cpp:18-19): an out-of-range assignment burns everything."""
YED_MAX_OUTPUT_CENTS = 10_000_000
TOKEN_VALUE_ZAT = 10_000
"""YEC carried by each wallet-built YED output (builder convention, src/yellowback/params.h:78)."""
DUST_ZAT = 54
"""Dust threshold of a P2PKH/P2SH output at the default relay fee (plan S-5, X-F15)."""


def chain_of_network(network: str) -> str:
    """``getblockchaininfo.chain`` of each network id (verification rule 2)."""
    return {YCASH_MAINNET: "main", YCASH_TESTNET: "test", YCASH_REGTEST: "regtest"}[network]


def is_ycash_network(network: str) -> bool:
    return network in YCASH_NETWORKS
