# Copyright (c) 2026 The Ycash developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or https://www.opensource.org/licenses/mit-license.php .
"""The next network-upgrade activation height (specs/scheme_batch_settlement_ycash.md, "Network
upgrades"; audit 06/X-1). A voucher commits to the consensus branch id current when it was signed
(ZIP-243), so the client's half of a voucher signed before an activation height cannot be mined at or
after it: a server closes every channel below the next activation, treating that height like t for its
margin. Mirrors packages/ycash/src/batch/upgrade.ts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def next_activation_height_of(upgrades: Mapping[str, Mapping[str, Any]] | None, tip: int) -> int | None:
    """The least ``activationheight`` among the upgrades listed as ``pending`` above ``tip``; None when
    none is. An entry at or below the tip (a misconfigured node) or without an integer height is ignored."""
    best: int | None = None
    for u in (upgrades or {}).values():
        h = u.get("activationheight")
        if u.get("status") != "pending" or not isinstance(h, int) or isinstance(h, bool) or h <= tip:
            continue
        if best is None or h < best:
            best = h
    return best
