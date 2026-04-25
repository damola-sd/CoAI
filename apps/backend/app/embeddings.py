from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod

from openai import AsyncOpenAI

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


class OpenAIEmbeddingsProvider(EmbeddingsProvider):
    def __init__(self, *, api_key: str, model: str) -> None:
        self._client = AsyncOpenAI(api_key=api_key)
        self._model = model

    async def embed(self, text: str) -> list[float]:
        resp = await self._client.embeddings.create(model=self._model, input=text)
        return list(resp.data[0].embedding)


def get_embeddings_provider() -> EmbeddingsProvider:
    if settings.embeddings_provider == "fake":
        return FakeEmbeddingsProvider(dim=settings.embeddings_dim)
    if settings.embeddings_provider == "openai":
        if not settings.openai_api_key:
            raise ValueError("COAI_OPENAI_API_KEY is required when COAI_EMBEDDINGS_PROVIDER=openai")
        return OpenAIEmbeddingsProvider(
            api_key=settings.openai_api_key,
            model=settings.openai_embeddings_model,
        )
    raise ValueError(f"Unsupported embeddings_provider: {settings.embeddings_provider}")
