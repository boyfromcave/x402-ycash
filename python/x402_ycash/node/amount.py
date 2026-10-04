"""YEC amounts across the RPC boundary. The node parses an amount with ParseFixedPoint(…, 8)
(src/rpc/server.cpp:119-129 v4.5.0, :110-120 6.21.0), so the SDK sends exact decimal strings built
from integer zatoshis and never a float."""

from __future__ import annotations

import re
from decimal import Decimal

ZAT_PER_YEC = 100_000_000
_AMOUNT = re.compile(r"^(-?)(\d+)(?:\.(\d{0,8}))?$")


def zat_to_yec_string(zat: int) -> str:
    """250000 -> "0.00250000"."""
    sign = "-" if zat < 0 else ""
    whole, frac = divmod(abs(zat), ZAT_PER_YEC)
    return f"{sign}{whole}.{frac:08d}"


def yec_to_zat(yec: float | str | Decimal) -> int:
    """A YEC amount the node printed (ValueFromAmount: a JSON number with at most 8 decimals) to
    zatoshis. JSON numbers are parsed as Decimal by the client (no float round trip); a float is
    formatted to 8 places first."""
    if isinstance(yec, float):
        s = f"{yec:.8f}"
    elif isinstance(yec, Decimal):
        s = format(yec, "f")
    else:
        s = str(yec).strip()
    m = _AMOUNT.match(s)
    if not m:
        raise ValueError(f"not a YEC amount: {s}")
    z = int(m.group(2)) * ZAT_PER_YEC + int((m.group(3) or "").ljust(8, "0"))
    return -z if m.group(1) == "-" else z
