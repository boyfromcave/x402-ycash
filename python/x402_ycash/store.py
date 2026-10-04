"""Duplicate-settlement guard shared by every facilitator worker (spec "Duplicate Settlement
Mitigation", REQUIRED), modelled on the Cardano mechanism's settlement store and mirroring
packages/ycash/src/store. ``claim`` is atomic: of any number of concurrent claims of one key, exactly
one returns True (across processes for SqliteSettlementStore)."""

from __future__ import annotations

import copy
import json
import math
import re
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

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


# --- channel stores ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class ChannelRecord:
    """A payment channel's state for X2/X3 (plan §5.7): the highest cumulative amount the payee holds a
    signature for. ``cumulative`` only moves through compare-and-set, so two workers redeeming vouchers
    on one channel cannot both advance it from the same value. Mirrors packages/ycash/src/store/channelStore.ts."""

    channel_id: str
    cumulative: int
    """zatoshis (YEC) or cents (YED), cumulative over the channel's life."""
    data: dict[str, Any] | None = None
    """Opaque binding-specific fields, JSON-serialisable."""


@runtime_checkable
class ChannelStore(Protocol):
    async def get(self, channel_id: str) -> ChannelRecord | None: ...

    async def open(self, record: ChannelRecord) -> bool:
        """Records a new channel; False if the id is already known."""
        ...

    async def compare_and_set_cumulative(self, channel_id: str, expected: int, next_value: int) -> bool:
        """Sets ``cumulative`` to ``next_value`` only if it is currently ``expected``; False otherwise (or unknown)."""
        ...

    async def delete(self, channel_id: str) -> None: ...

    async def list(self) -> list[str]:
        """Every record id, in no particular order (a restarted server re-tracks its channels from it)."""
        ...


class InMemoryChannelStore:
    """Process-local, thread-safe (the sync bridge runs schemes on its own loop thread)."""

    def __init__(self) -> None:
        self._records: dict[str, ChannelRecord] = {}
        self._lock = threading.Lock()

    async def get(self, channel_id: str) -> ChannelRecord | None:
        with self._lock:
            r = self._records.get(channel_id)
        return None if r is None else ChannelRecord(r.channel_id, r.cumulative, copy.deepcopy(r.data))

    async def open(self, record: ChannelRecord) -> bool:
        with self._lock:
            if record.channel_id in self._records:
                return False
            self._records[record.channel_id] = ChannelRecord(record.channel_id, record.cumulative, copy.deepcopy(record.data))
            return True

    async def compare_and_set_cumulative(self, channel_id: str, expected: int, next_value: int) -> bool:
        with self._lock:
            r = self._records.get(channel_id)
            if r is None or r.cumulative != expected:
                return False
            self._records[channel_id] = ChannelRecord(channel_id, next_value, r.data)
            return True

    async def delete(self, channel_id: str) -> None:
        with self._lock:
            self._records.pop(channel_id, None)

    async def list(self) -> list[str]:
        with self._lock:
            return list(self._records)


class SqliteChannelStore:
    """Restart-durable and shared by every process on one host. ``cumulative`` is stored as decimal
    text (a cumulative or a lock expiry can exceed SQLite's comparisons of mixed types); the
    compare-and-set is one ``UPDATE … WHERE cumulative = ?``."""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._lock = threading.Lock()
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, cumulative TEXT NOT NULL, data TEXT)")

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._path, timeout=30, isolation_level=None)

    async def get(self, channel_id: str) -> ChannelRecord | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT cumulative, data FROM channels WHERE id = ?", (channel_id,)).fetchone()
        if row is None:
            return None
        return ChannelRecord(channel_id, int(row[0]), json.loads(row[1]) if row[1] is not None else None)

    async def open(self, record: ChannelRecord) -> bool:
        data = json.dumps(record.data) if record.data is not None else None
        with self._lock, self._connect() as db:
            cur = db.execute("INSERT OR IGNORE INTO channels (id, cumulative, data) VALUES (?, ?, ?)",
                             (record.channel_id, str(record.cumulative), data))
            return cur.rowcount == 1

    async def compare_and_set_cumulative(self, channel_id: str, expected: int, next_value: int) -> bool:
        with self._lock, self._connect() as db:
            cur = db.execute("UPDATE channels SET cumulative = ? WHERE id = ? AND cumulative = ?",
                             (str(next_value), channel_id, str(expected)))
            return cur.rowcount == 1

    async def delete(self, channel_id: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM channels WHERE id = ?", (channel_id,))

    async def list(self) -> list[str]:
        with self._lock, self._connect() as db:
            return [r[0] for r in db.execute("SELECT id FROM channels").fetchall()]
