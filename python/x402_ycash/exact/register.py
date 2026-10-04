"""Registration helpers, shaped like upstream's ``register_exact_svm_*`` (mechanisms/svm/exact/register.py).
Ycash has no x402 v1 networks, so only V2 is registered."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

from ..constants import YCASH_CAIP_FAMILY

if TYPE_CHECKING:
    from x402 import (
        x402Client,
        x402ClientSync,
        x402Facilitator,
        x402FacilitatorSync,
        x402ResourceServer,
        x402ResourceServerSync,
    )

    from .server import YecPriceSource
    from .verify import ExactFacilitatorRpc

ClientT = TypeVar("ClientT", "x402Client", "x402ClientSync")
ServerT = TypeVar("ServerT", "x402ResourceServer", "x402ResourceServerSync")
FacilitatorT = TypeVar("FacilitatorT", "x402Facilitator", "x402FacilitatorSync")


def _as_list(networks: str | list[str]) -> list[str]:
    return [networks] if isinstance(networks, str) else list(networks)


def register_exact_ycash_facilitator(
    facilitator: FacilitatorT,
    rpc: ExactFacilitatorRpc,
    networks: str | list[str],
    **config: Any,
) -> FacilitatorT:
    """Registers the exact facilitator for the given networks (each facilitator serves the one
    chain its node runs: rule 2 refuses any other). ``config`` goes to ExactYcashFacilitatorScheme."""
    from .facilitator import ExactYcashFacilitatorScheme

    facilitator.register(_as_list(networks), ExactYcashFacilitatorScheme(rpc, **config))
    return facilitator


def register_exact_ycash_server(
    server: ServerT,
    networks: str | list[str] | None = None,
    price_source: YecPriceSource | None = None,
    zero_conf_cap_zat: int | None = None,
    **config: Any,
) -> ServerT:
    """Registers the exact server scheme for ``networks`` (default: the ``ycash:*`` wildcard).
    ``config`` (``usd_asset``, ``shielded``) goes to ExactYcashServerScheme."""
    from .server import ExactYcashServerScheme

    scheme = ExactYcashServerScheme(price_source, zero_conf_cap_zat, **config)
    for network in _as_list(networks) if networks else [YCASH_CAIP_FAMILY]:
        server.register(network, scheme)
    return server


def register_exact_ycash_client(
    client: ClientT,
    rpc: Any,
    priv_key: bytes,
    networks: str | list[str] | None = None,
) -> ClientT:
    """Registers the exact client scheme (local key, coins from the node)."""
    from .client import ExactYcashClientScheme

    scheme = ExactYcashClientScheme(rpc, priv_key)
    for network in _as_list(networks) if networks else [YCASH_CAIP_FAMILY]:
        client.register(network, scheme)
    return client
