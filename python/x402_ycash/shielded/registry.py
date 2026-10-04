"""The issued-address registry of a ``sapling-proof`` server: which per-request addresses it issued,
and the request record behind each (spec, "sapling-proof": an address is never issued twice; the
server holds every record at least until expiresAt plus the time the policy depth takes). Mirrors
packages/ycash/src/shielded/registry.ts; the durable form here is SQLite, shared by the merchant's
server and its self-hosted facilitator on one host."""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from ..constants import BLOCK_SECONDS
from .request import RequestRecord


@dataclass(frozen=True)
class IssuedRequest:
    """What the server remembers about one issued address."""

    record: RequestRecord
    memo: str
    """extra.memo, "x402:" + request hash."""
    confirmations: int
    """extra.confirmationPolicy.confirmations in force for this request."""
    issued_at: int
    """Unix seconds."""
    retain_until: int
    """Unix seconds after which the record may be pruned (the address itself is never forgotten)."""

    def to_json(self) -> dict[str, Any]:
        return {"record": dict(self.record), "memo": self.memo, "confirmations": self.confirmations,
                "issuedAt": self.issued_at, "retainUntil": self.retain_until}

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> IssuedRequest:
        return cls(d["record"], d["memo"], d["confirmations"], d["issuedAt"], d["retainUntil"])


def record_retain_until(expires_at: int, confirmations: int, grace_seconds: int) -> int:
    """expiresAt, plus twice the time the policy depth takes at the 75-second target spacing (blocks
    are Poisson, so one spacing per confirmation is only the mean), plus a grace period."""
    return expires_at + 2 * max(confirmations, 1) * BLOCK_SECONDS + grace_seconds


@runtime_checkable
class IssuedAddressRegistry(Protocol):
    async def issue(self, pay_to: str, request: IssuedRequest) -> bool:
        """Records an issued address; False if it was ever issued before (it must not be reused)."""
        ...

    async def get(self, pay_to: str) -> IssuedRequest | None:
        """The record for ``pay_to``, while it is held."""
        ...

    async def was_issued(self, pay_to: str) -> bool:
        """True if ``pay_to`` was ever issued, even after its record was pruned."""
        ...

    async def outstanding(self, now: int) -> int:
        """Records still held (for an issuance limit)."""
        ...

    async def prune(self, now: int) -> int:
        """Drops records whose retain_until is before ``now``; keeps the addresses. Returns how many."""
        ...


class InMemoryIssuedAddressRegistry:
    """Process-local registry: tests, or a single process whose restart may forget open requests."""

    def __init__(self) -> None:
        self._records: dict[str, IssuedRequest] = {}
        self._issued: set[str] = set()
        self._lock = threading.Lock()

    async def issue(self, pay_to: str, request: IssuedRequest) -> bool:
        with self._lock:
            if pay_to in self._issued:
                return False
            self._issued.add(pay_to)
            self._records[pay_to] = request
            return True

    async def get(self, pay_to: str) -> IssuedRequest | None:
        with self._lock:
            return self._records.get(pay_to)

    async def was_issued(self, pay_to: str) -> bool:
        with self._lock:
            return pay_to in self._issued

    async def outstanding(self, now: int) -> int:
        with self._lock:
            return sum(1 for r in self._records.values() if r.retain_until >= now)

    async def prune(self, now: int) -> int:
        with self._lock:
            gone = [k for k, r in self._records.items() if r.retain_until < now]
            for k in gone:
                del self._records[k]
            return len(gone)


class SqliteIssuedAddressRegistry:
    """Restart-durable and shared by every process on one host. A pruned address keeps its row
    with the record cleared (``retired``), so ``INSERT OR IGNORE`` refuses it forever."""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._lock = threading.Lock()
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS issued (pay_to TEXT PRIMARY KEY, record TEXT, retain_until INTEGER)")

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._path, timeout=30, isolation_level=None)

    async def issue(self, pay_to: str, request: IssuedRequest) -> bool:
        with self._lock, self._connect() as db:
            cur = db.execute("INSERT OR IGNORE INTO issued (pay_to, record, retain_until) VALUES (?, ?, ?)",
                             (pay_to, json.dumps(request.to_json()), request.retain_until))
            return cur.rowcount == 1

    async def get(self, pay_to: str) -> IssuedRequest | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT record FROM issued WHERE pay_to = ? AND record IS NOT NULL", (pay_to,)).fetchone()
        return IssuedRequest.from_json(json.loads(row[0])) if row else None

    async def was_issued(self, pay_to: str) -> bool:
        with self._lock, self._connect() as db:
            return db.execute("SELECT 1 FROM issued WHERE pay_to = ?", (pay_to,)).fetchone() is not None

    async def outstanding(self, now: int) -> int:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT COUNT(*) FROM issued WHERE record IS NOT NULL AND retain_until >= ?", (now,)).fetchone()
        return int(row[0])

    async def prune(self, now: int) -> int:
        with self._lock, self._connect() as db:
            return db.execute("UPDATE issued SET record = NULL WHERE record IS NOT NULL AND retain_until < ?", (now,)).rowcount
