from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import SessionLocal
from .embeddings import get_embeddings_provider
from .models import Chunk, Repo, RepoStatus

TEXT_EXT_ALLOWLIST = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".md",
    ".txt",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".env",
    ".sql",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".rb",
    ".php",
    ".sh",
}

DIR_DENYLIST = {".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv", "venv"}


@dataclass(frozen=True)
class ChunkSpec:
    path: str
    start_line: int
    end_line: int
    content: str


def _is_probably_text(data: bytes) -> bool:
    # Simple heuristic: reject if NUL byte is present.
    return b"\x00" not in data


def _iter_files(repo_dir: Path) -> list[Path]:
    files: list[Path] = []
    for root, dirs, filenames in os.walk(repo_dir):
        dirs[:] = [d for d in dirs if d not in DIR_DENYLIST]
        for fn in filenames:
            p = Path(root) / fn
            if p.suffix and p.suffix.lower() not in TEXT_EXT_ALLOWLIST:
                continue
            files.append(p)
    return files


def _chunk_text(path: str, text: str, lines_per_chunk: int = 200) -> list[ChunkSpec]:
    lines = text.splitlines()
    out: list[ChunkSpec] = []
    for i in range(0, len(lines), lines_per_chunk):
        chunk_lines = lines[i : i + lines_per_chunk]
        if not chunk_lines:
            continue
        out.append(
            ChunkSpec(
                path=path,
                start_line=i + 1,
                end_line=i + len(chunk_lines),
                content="\n".join(chunk_lines),
            )
        )
    return out


def _clone_repo(repo_url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    subprocess.run(["git", "clone", "--depth", "1", repo_url, str(dest)], check=True)


async def ingest_repo(session: AsyncSession, repo_id: uuid.UUID) -> None:
    repo = await session.scalar(select(Repo).where(Repo.id == repo_id))
    if repo is None:
        return

    await session.execute(
        update(Repo).where(Repo.id == repo_id).values(status=RepoStatus.ingesting, error=None)
    )
    await session.commit()

    storage_root = Path(settings.repo_storage_path)
    dest = storage_root / str(repo_id)

    try:
        _clone_repo(repo.url, dest)

        embedder = get_embeddings_provider()
        files = _iter_files(dest)

        for f in files:
            rel = str(f.relative_to(dest))
            data = f.read_bytes()
            if not _is_probably_text(data):
                continue
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                continue

            for spec in _chunk_text(rel, text):
                emb = await embedder.embed(spec.content)
                session.add(
                    Chunk(
                        repo_id=repo_id,
                        path=spec.path,
                        start_line=spec.start_line,
                        end_line=spec.end_line,
                        content=spec.content,
                        meta={},
                        embedding=emb,
                    )
                )

        await session.execute(
            update(Repo).where(Repo.id == repo_id).values(status=RepoStatus.ready)
        )
        await session.commit()

    except Exception as e:  # noqa: BLE001
        await session.execute(
            update(Repo).where(Repo.id == repo_id).values(status=RepoStatus.failed, error=str(e))
        )
        await session.commit()


async def ingest_repo_job(repo_id: uuid.UUID) -> None:
    async with SessionLocal() as session:
        await ingest_repo(session, repo_id)
