from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod

from .config import settings


class EmbeddingsProvider(ABC):
    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        raise NotImplementedError


class FakeEmbeddingsProvider(EmbeddingsProvider):
    """
    Deterministic "fake" embeddings for local dev.
    This keeps Phase 2 fully runnable without external API keys.
    """

    def __init__(self, dim: int) -> None:
        self.dim = dim

    async def embed(self, text: str) -> list[float]:
        # Expand SHA256 digest to fill `dim` floats in [-1, 1]
        seed = hashlib.sha256(text.encode("utf-8")).digest()
        out: list[float] = []
        i = 0
        while len(out) < self.dim:
            b = seed[i % len(seed)]
            out.append((b / 255.0) * 2.0 - 1.0)
            i += 1
        return out


def get_embeddings_provider() -> EmbeddingsProvider:
    if settings.embeddings_provider == "fake":
        return FakeEmbeddingsProvider(dim=settings.embeddings_dim)
    raise ValueError(f"Unsupported embeddings_provider: {settings.embeddings_provider}")
