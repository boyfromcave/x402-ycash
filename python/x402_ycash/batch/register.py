"""Registration helpers, shaped like the exact scheme's (x402_ycash.exact.register)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

from ..constants import YCASH_CAIP_FAMILY

if TYPE_CHECKING:
    from x402 import x402Facilitator, x402FacilitatorSync, x402ResourceServer

    from .server import BatchYcashServerScheme
    from .verify import ChainView

FacilitatorT = TypeVar("FacilitatorT", "x402Facilitator", "x402FacilitatorSync")


def _as_list(networks: str | list[str]) -> list[str]:
    return [networks] if isinstance(networks, str) else list(networks)


def register_batch_ycash_facilitator(facilitator: FacilitatorT, rpc: ChainView, networks: str | list[str], **config: Any) -> FacilitatorT:
    """Registers the batch-settlement facilitator for ``networks``; ``config`` goes to BatchYcashFacilitatorScheme."""
    from .facilitator import BatchYcashFacilitatorScheme

    facilitator.register(_as_list(networks), BatchYcashFacilitatorScheme(rpc, **config))
    return facilitator


def register_batch_ycash_server(server: x402ResourceServer, chain: ChainView, server_priv_key: bytes,
                                networks: str | list[str] | None = None, **config: Any) -> BatchYcashServerScheme:
    """Registers the batch-settlement server scheme (default network: the ``ycash:*`` wildcard) on the
    async resource server, whose hooks it uses; returns the scheme (its ``manager`` drives closes and
    ``manager.watcher()`` the close triggers). ``config`` goes to BatchYcashServerScheme."""
    from .server import BatchYcashServerScheme

    scheme = BatchYcashServerScheme(chain, server_priv_key, **config)
    for network in _as_list(networks) if networks else [YCASH_CAIP_FAMILY]:
        server.register(network, scheme)
    return scheme
