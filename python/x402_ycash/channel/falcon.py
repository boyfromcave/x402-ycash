# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license.
"""YED channels across the node's Falcon height F (quantum spec R-A2, A-1, TOK-PQ; D-Q-19). Mirrors
packages/ycash/src/channel/falcon.ts.

From F the module's TOK-PQ rule lets only a scheme-2 (FN-DSA-512) TX_PQPKH, or a TX_PQCHANNEL with a
scheme-2 client, receive YED; before F the node's policy refuses any scheme-2 output. So a YED channel
opened at or after F is a TX_PQCHANNEL with a Falcon client whose voucher outputs are Falcon TX_PQPKH,
and one opened before F (P2SH, or an SLH-DSA client) must be funded and closed below F: its
``close_by`` is min(t, F). The owner's decision of 2026-10-10 puts F at 0 on mainnet and testnet."""

from __future__ import annotations

import weakref
from typing import Any

from ..constants import ASSET_YED, YCASH_MAINNET, YCASH_REGTEST, YCASH_TESTNET
from ..pq import SCHEME_FN_DSA_512, SCHEME_SLH_DSA_SHA2_128S, pqpkh_key_id

FALCON_NEVER = -1
DEFAULT_FALCON_HEIGHT: dict[str, int] = {YCASH_MAINNET: 0, YCASH_TESTNET: 0, YCASH_REGTEST: FALCON_NEVER}


def is_falcon_active_at(falcon_height: int, height: int) -> bool:
    """The node's IsPQFalconActive: height >= F >= 0 (for an unmined transaction, height = tip + 1)."""
    return falcon_height >= 0 and height >= falcon_height


def falcon_height_of(info: dict[str, Any]) -> int | None:
    """F from ``yed_getinfo`` (rpcversion 7: ``params.pq.falconHeight``), or None."""
    h = ((info.get("params") or {}).get("pq") or {}).get("falconHeight")
    return h if isinstance(h, int) and not isinstance(h, bool) and h >= FALCON_NEVER else None


_cache: weakref.WeakKeyDictionary[Any, int] = weakref.WeakKeyDictionary()


async def read_falcon_height(chain: Any, network: str) -> int:
    """F as the node reports it (cached per node object: a fixed consensus parameter), else the network default."""
    try:
        return _cache[chain]
    except (KeyError, TypeError):
        pass
    h: int | None = None
    get = getattr(chain, "yed_get_info", None)
    if callable(get):
        try:
            h = falcon_height_of(await get())
        except Exception:  # noqa: BLE001 - a node without the overlay: the network default
            h = None
    if h is None:
        return DEFAULT_FALCON_HEIGHT.get(network, FALCON_NEVER)
    try:
        _cache[chain] = h
    except TypeError:
        pass
    return h


def is_falcon_holder(spk: bytes) -> bool:
    """A Falcon (scheme-2) TX_PQPKH: the only YED holder output after F."""
    kid = pqpkh_key_id(spk)
    return kid is not None and kid.scheme == SCHEME_FN_DSA_512


def yed_holder_problem(spk: bytes, falcon_active: bool) -> str | None:
    """Why ``spk`` cannot receive YED in a transaction mined under ``falcon_active``, or None."""
    kid = pqpkh_key_id(spk)
    falcon = kid is not None and kid.scheme == SCHEME_FN_DSA_512
    if falcon_active:
        return None if falcon else "after the Falcon height only a Falcon (scheme-2) post-quantum address holds YED (TOK-PQ)"
    return "a Falcon (scheme-2) address cannot receive outputs before the Falcon height (node policy)" if falcon else None


def yed_channel_client_scheme(falcon_active: bool) -> int:
    return SCHEME_FN_DSA_512 if falcon_active else SCHEME_SLH_DSA_SHA2_128S


def channel_close_by(asset: str, client_scheme: int | None, refund_height: int, falcon_height: int) -> int:
    """t, or min(t, F) for a YED channel opened before F (``client_scheme`` None for a P2SH channel)."""
    if asset != ASSET_YED or falcon_height < 0 or client_scheme == SCHEME_FN_DSA_512:
        return refund_height
    return min(refund_height, falcon_height)


def margin_height_of(refund_height: int, close_margin_blocks: int, close_by: int | None = None) -> int:
    """min(t, closeBy) − closeMarginBlocks: the height from which a channel is inside its close margin."""
    return min(refund_height, refund_height if close_by is None else close_by) - close_margin_blocks
