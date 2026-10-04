"""JSON-RPC errors ycashd returns (src/rpc/protocol.h on both lines) and how a facilitator reads a
``sendrawtransaction`` failure."""

from __future__ import annotations

import re
from typing import Literal

RPC_METHOD_NOT_FOUND = -32601
RPC_INVALID_ADDRESS_OR_KEY = -5
RPC_VERIFY_ERROR = -25
RPC_VERIFY_REJECTED = -26
RPC_VERIFY_ALREADY_IN_CHAIN = -27
RPC_IN_WARMUP = -28


class RpcError(Exception):
    """An error the node returned, or a transport failure (code 0 with ``transport`` set)."""

    def __init__(self, code: int, message: str, method: str, *, http_status: int | None = None,
                 transport: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.method = method
        self.http_status = http_status
        self.transport = transport
        """Set when the call never got a JSON-RPC answer (refused, timed out, unauthorised, not JSON)."""


SendRawTransactionErrorKind = Literal[
    "already-in-chain", "mempool-conflict", "missing-inputs", "expiring-soon", "rejected", "failed",
]


def classify_send_error(code: int, reason: str) -> SendRawTransactionErrorKind:
    """The two lines refuse a mempool double spend differently: 6.21.0 rejects it as
    ``-26 "18: txn-mempool-conflict"`` (ycash6/src/main.cpp:1839-1842), while v4.5.0's
    AcceptToMemoryPool returns false without a reason (ycash-dd/src/main.cpp:1579-1583), which
    sendrawtransaction reports as ``-25`` with an empty message (rawtransaction.cpp:1161-1166; X-F7)."""
    if code == RPC_VERIFY_ALREADY_IN_CHAIN:
        return "already-in-chain"
    if "txn-mempool-conflict" in reason:
        return "mempool-conflict"
    if code == RPC_VERIFY_ERROR and reason == "":
        return "mempool-conflict"
    if code == RPC_VERIFY_ERROR and reason.lower() == "missing inputs":
        return "missing-inputs"
    if "bad-txns-inputs-spent" in reason:
        return "missing-inputs"
    if re.search(r"tx-expiring-soon|tx-overwinter-expired|expired", reason, re.IGNORECASE):
        return "expiring-soon"
    if code == RPC_VERIFY_REJECTED:
        return "rejected"
    return "failed"


class SendRawTransactionError(RpcError):
    def __init__(self, cause: RpcError) -> None:
        super().__init__(cause.code, cause.message, cause.method, http_status=cause.http_status)
        m = re.match(r"^(\d+): (.*)$", cause.message, re.DOTALL)
        self.reject_code: int | None = int(m.group(1)) if m else None
        """The node's REJECT_* code, when the message carries one ("18: txn-mempool-conflict")."""
        self.reject_reason: str = m.group(2) if m else cause.message
        self.kind: SendRawTransactionErrorKind = classify_send_error(cause.code, self.reject_reason)
