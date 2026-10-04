import json
from pathlib import Path
from typing import Any

import pytest

VECTORS = Path(__file__).resolve().parents[2] / "vectors"


def load_vector(rel: str) -> Any:
    return json.loads((VECTORS / rel).read_text())


@pytest.fixture
def vectors_dir() -> Path:
    return VECTORS
