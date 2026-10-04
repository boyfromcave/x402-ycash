"""Duplicate-settlement guard shared by every facilitator worker (spec "Duplicate Settlement
Mitigation", REQUIRED), modelled on the Cardano mechanism's settlement store and mirroring
packages/ycash/src/store. ``claim`` is atomic: of any number of concurrent claims of one key, exactly
one returns True (across processes for SqliteSettlementStore)."""

from __future__ import annotations

import math
import re
import sqlite3
import threading
from pathlib import Path
from typing import Protocol, runtime_checkable

SETTLEMENT_RETENTION_BLOCKS = 10
"""Blocks a claim outlives nExpiryHeight: after expiry the node refuses the tx (plan §5.6)."""
RETAIN_FOREVER = math.inf
"""The Lightning rule, for a consumption key that must never be reused."""

_TXID = re.compile(r"^[0-9a-fA-F]{64}$")


def consumption_key(network: str, ident: str) -> str:
    """The durable key ``ycash:<net>:<id>``: the network id already carries the namespace."""
    if not ident or ":" in ident:
        raise ValueError(f"consumption id must be non-empty and colon-free: {ident}")
    return f"{network}:{ident}"


def txid_key(network: str, txid: str) -> str:
    """The key of a transparent payment: its txid, lowercase, under the network."""
    if not _TXID.match(txid):
        raise ValueError(f"not a txid: {txid}")
    return consumption_key(network, txid.lower())


def retain_until_for_expiry(expiry_height: int) -> int:
    """retainUntilHeight for a tx: its expiry plus the retention margin. An expiry of 0 is refused."""
    if expiry_height <= 0:
        raise ValueError(f"expiry height must be positive: {expiry_height}")
    return expiry_height + SETTLEMENT_RETENTION_BLOCKS


@runtime_checkable
class SettlementStore(Protocol):
    async def claim(self, key: str, retain_until_height: float) -> bool:
        """Atomically takes ``key``; False if already held. Kept until ``prune`` passes retain_until_height."""
        ...

    async def release(self, key: str) -> None:
        """Gives a claim back when the node certainly did not accept the transaction."""
        ...

    async def is_claimed(self, key: str) -> bool: ...

    async def prune(self, current_height: int) -> int:
        """Drops every claim whose retain_until_height is below current_height; returns how many."""
        ...


class InMemorySettlementStore:
    """Process-local store: a single facilitator process, or tests. Thread-safe, because the sync
    bridge runs the facilitator on its own event-loop thread."""

    def __init__(self) -> None:
        self._claims: dict[str, float] = {}
        self._lock = threading.Lock()

    async def claim(self, key: str, retain_until_height: float) -> bool:
        with self._lock:
            if key in self._claims:
                return False
            self._claims[key] = retain_until_height
            return True

    async def release(self, key: str) -> None:
        with self._lock:
            self._claims.pop(key, None)

    async def is_claimed(self, key: str) -> bool:
        with self._lock:
            return key in self._claims

    async def prune(self, current_height: int) -> int:
        with self._lock:
            gone = [k for k, until in self._claims.items() if until < current_height]
            for k in gone:
                del self._claims[k]
            return len(gone)


class SqliteSettlementStore:
    """A restart-durable store shared by every process on one host: ``INSERT OR IGNORE`` on a primary
    key is the atomic claim. RETAIN_FOREVER is stored as NULL."""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._lock = threading.Lock()
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, retain_until INTEGER)")

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._path, timeout=30, isolation_level=None)

    async def claim(self, key: str, retain_until_height: float) -> bool:
        until = None if retain_until_height == RETAIN_FOREVER else int(retain_until_height)
        with self._lock, self._connect() as db:
            cur = db.execute("INSERT OR IGNORE INTO claims (key, retain_until) VALUES (?, ?)", (key, until))
            return cur.rowcount == 1

    async def release(self, key: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM claims WHERE key = ?", (key,))

    async def is_claimed(self, key: str) -> bool:
        with self._lock, self._connect() as db:
            return db.execute("SELECT 1 FROM claims WHERE key = ?", (key,)).fetchone() is not None

    async def prune(self, current_height: int) -> int:
        with self._lock, self._connect() as db:
            return db.execute("DELETE FROM claims WHERE retain_until IS NOT NULL AND retain_until < ?",
                              (current_height,)).rowcount
