"""Reading the overlay's own answers about a TRANSFER: ``yed_decodepayload`` and
``yed_validaterawtransaction`` (plan Y-9; ycash-dd/src/rpc/yellowback.cpp:1384-1488, ycash6 :1372,
:1428, identical fields). Pure functions over the RPC results, shared by the exact facilitator
(rules 4Y, 9Y) and the channel server and facilitator (YED channels). Mirrors
packages/ycash/src/yed/verdict.ts."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from .payload import Assignment

YED_VERDICT_OK = "ok"
"""The overlay's verdict strings are lowercase (ycash-dd/src/yellowback/state.cpp:23-24, same on ycash6)."""
YED_VERDICT_BURNED = "burned"

TransferVerdictProblem = Literal["scripts", "type", "verdict", "burned", "yed_in", "unconfirmed_input"]


@dataclass(frozen=True)
class VerdictProblem:
    problem: TransferVerdictProblem
    message: str


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def check_transfer_verdict(v: Mapping[str, Any], yed_in: int | None = None, scripts: bool = True) -> VerdictProblem | None:
    """The verdict a non-burning TRANSFER must have: type ``transfer``, verdict ``ok``, burned 0,
    yedOut = yedIn, no unconfirmed input, and (``scripts``) a ``valid`` script verdict; with
    ``yed_in``, exactly that yedIn (a channel's D). Returns the first problem, or None.

    ``scripts`` is False for a voucher whose server slot is still empty: it cannot pass the script
    verifier by construction, and its scripts are checked once completed."""
    if scripts and v.get("valid") is not True:
        return VerdictProblem("scripts", "yed_validaterawtransaction: the scripts do not verify")
    unconfirmed = v.get("unconfirmedInputs") or []
    if unconfirmed:
        listed = ", ".join(f"{o.get('txid')}:{o.get('vout')}" for o in unconfirmed)
        return VerdictProblem("unconfirmed_input", f"inputs not in a block: {listed}")
    if v.get("type") != "transfer":
        return VerdictProblem("type", f"overlay type {v.get('type')}, not transfer")
    if v.get("verdict") != YED_VERDICT_OK:
        return VerdictProblem("verdict", f"overlay verdict {v.get('verdict')}")
    got_in, got_out, burned = v.get("yedIn"), v.get("yedOut"), v.get("burned")
    if not (_is_int(got_in) and _is_int(got_out) and _is_int(burned)) or burned != 0 or got_out != got_in:
        return VerdictProblem("burned", f"burns {burned} cents (yedIn {got_in}, yedOut {got_out})")
    if yed_in is not None and got_in != yed_in:
        return VerdictProblem("yed_in", f"yedIn {got_in}, expected {yed_in}")
    return None


@dataclass(frozen=True)
class DecodedTransfer:
    op_return_index: int
    assignments: tuple[Assignment, ...]


def decoded_transfer_of(p: Mapping[str, Any]) -> DecodedTransfer | None:
    """The TRANSFER ``yed_decodepayload(hex)`` found in a transaction, or None for anything else."""
    if p.get("valid") is not True or p.get("type") != "transfer" or not _is_int(p.get("opReturnIndex")):
        return None
    raw = p.get("assignments")
    if not isinstance(raw, list):
        return None
    out: list[Assignment] = []
    for a in raw:
        if not isinstance(a, dict) or not _is_int(a.get("vout")) or not _is_int(a.get("cents")):
            return None
        out.append(Assignment(a["vout"], a["cents"]))
    return DecodedTransfer(int(p["opReturnIndex"]), tuple(out))


def same_assignments(a: Sequence[Assignment], b: Sequence[Assignment]) -> bool:
    """The two lists name the same vouts with the same cents (order ignored)."""
    if len(a) != len(b):
        return False
    want = {(x.vout, x.cents) for x in b}
    return len(want) == len(b) and all((x.vout, x.cents) in want for x in a)


def assigned_to(assignments: Sequence[Assignment], vout: int) -> int | None:
    """The cents assigned to ``vout`` when exactly one assignment names it."""
    hits = [a for a in assignments if a.vout == vout]
    return hits[0].cents if len(hits) == 1 else None
