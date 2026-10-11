"""A small tip watcher for channels (specs/scheme_batch_settlement_ycash.md, "Security Considerations":
the margin and a watcher on tip height are REQUIRED for a server). It warns once per channel when the
tip reaches t − closeMarginBlocks and hands the channel to ``on_margin`` (the server closes). Mirrors
packages/ycash/src/batch/watcher.ts, on asyncio."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass

from ..channel.falcon import margin_height_of

log = logging.getLogger("x402_ycash.batch")


@dataclass(frozen=True)
class WatchedChannel:
    channel_id: str
    refund_height: int
    close_margin_blocks: int
    close_by: int | None = None
    """The height it must be closed below when earlier than t (a YED channel opened before the Falcon height)."""

    @property
    def margin_height(self) -> int:
        return margin_height_of(self.refund_height, self.close_margin_blocks, self.close_by)


class ChannelWatcher:
    def __init__(self, tip: Callable[[], Awaitable[int]], channels: Callable[[], Awaitable[Iterable[WatchedChannel]]],
                 on_margin: Callable[[WatchedChannel, int], Awaitable[None]],
                 on_tick: Callable[[int], Awaitable[None]] | None = None,
                 warn: Callable[[str], None] | None = None, poll: float = 15.0) -> None:
        self._tip = tip
        self._channels = channels
        self._on_margin = on_margin
        self._on_tick = on_tick
        self._warn = warn or log.warning
        self._poll = poll
        self._warned: set[str] = set()
        self._task: asyncio.Task[None] | None = None

    async def check(self) -> list[WatchedChannel]:
        """One pass; returns the channels at or past their margin."""
        tip = await self._tip()
        due: list[WatchedChannel] = []
        for ch in await self._channels():
            if tip < ch.margin_height:
                continue
            due.append(ch)
            if ch.channel_id not in self._warned:
                self._warned.add(ch.channel_id)
                what = "the Falcon height" if ch.close_by is not None and ch.close_by < ch.refund_height else "t"
                self._warn(f"channel {ch.channel_id}: tip {tip} reached {what} − margin = {ch.margin_height} (t = {ch.refund_height})")
            await self._on_margin(ch, tip)
        if self._on_tick is not None:
            await self._on_tick(tip)
        return due

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._poll)
            try:
                await self.check()
            except Exception as e:  # noqa: BLE001  # a node hiccup must not stop the watcher
                self._warn(f"channel watcher: {e}")

    def start(self) -> None:
        """Runs on the caller's event loop until stop()."""
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
