"""The bridge from upstream's sync scheme protocols to this package's async node client.

x402's Python protocols are sync: ``x402Facilitator.verify`` (async) calls
``scheme.verify(...)`` without awaiting it (x402/facilitator_base.py ``_verify_v2``), and so does
the resource server for ``parse_price``. The mechanism's logic is async (``averify``/``asettle``);
the sync methods run it on one private event-loop thread, which works whether or not the caller
is itself inside a running loop. It blocks the caller exactly as a sync RPC client would.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar

T = TypeVar("T")

_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None


def _bridge_loop() -> asyncio.AbstractEventLoop:
    global _loop
    with _lock:
        if _loop is None or _loop.is_closed():
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, name="x402-ycash-bridge", daemon=True).start()
            _loop = loop
        return _loop


def run_sync(coro: Coroutine[Any, Any, T]) -> T:
    """Run ``coro`` to completion on the bridge loop and return its result."""
    loop = _bridge_loop()
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        coro.close()
        raise RuntimeError("run_sync called from the bridge loop itself; await the async method instead")
    return asyncio.run_coroutine_threadsafe(coro, loop).result()
