from __future__ import annotations

import uuid

from sqlalchemy import Select, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .embeddings import get_embeddings_provider
from .models import Chunk


def _text_search_stmt(repo_id: uuid.UUID, question: str, limit: int) -> Select[tuple[Chunk]]:
    """
    Local-friendly retrieval.

    Uses Postgres full-text search when possible, with an ILIKE fallback.
    This gives meaningful results even when embeddings are "fake".
    """
    q = question.strip()
    if not q:
        return (
            select(Chunk)
            .where(Chunk.repo_id == repo_id)
            .order_by(Chunk.created_at.desc())
            .limit(limit)
        )

    # plainto_tsquery is resilient for plain user input
    ts_rank = func.ts_rank_cd(
        func.to_tsvector("english", Chunk.content), func.plainto_tsquery("english", q)
    )
    return (
        select(Chunk)
        .where(Chunk.repo_id == repo_id)
        .where(func.to_tsvector("english", Chunk.content).op("@@")(func.plainto_tsquery("english", q)))
        .order_by(ts_rank.desc(), Chunk.created_at.desc())
        .limit(limit)
    )


async def retrieve_chunks(
    session: AsyncSession, repo_id: uuid.UUID, question: str, limit: int = 5
) -> list[Chunk]:
    """
    Retrieval:
    - If embeddings provider is "fake": use text search (local, deterministic).
    - Otherwise: use vector similarity against `embedding` (Phase 3+).
    """

    if settings.embeddings_provider == "fake":
        try:
            result = await session.execute(_text_search_stmt(repo_id, question, limit))
            rows = list(result.scalars().all())
            if rows:
                return rows
        except Exception:  # noqa: BLE001
            # If FTS isn't available for any reason, fall back to a simple substring match.
            pass

        q = question.strip()
        stmt = (
            select(Chunk)
            .where(Chunk.repo_id == repo_id)
            .where(Chunk.content.ilike(f"%{q}%") if q else true())
            .order_by(Chunk.created_at.desc())
            .limit(limit)
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    embedder = get_embeddings_provider()
    query_vec = await embedder.embed(question)

    # pgvector sqlalchemy adds distance helpers on the Vector column.
    stmt = (
        select(Chunk)
        .where(Chunk.repo_id == repo_id)
        .where(Chunk.embedding.is_not(None))
        .order_by(Chunk.embedding.cosine_distance(query_vec))  # type: ignore[attr-defined]
        .limit(limit)
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())
