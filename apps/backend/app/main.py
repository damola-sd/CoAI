import uuid

import asyncio
import json

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from coai_orchestrator import build_multi_agent_qa_graph, build_qa_graph

from .config import settings
from .db import get_db
from .ingestion import ingest_repo_job
from .models import Repo, RepoStatus
from .retrieval import retrieve_chunks
from .schemas import QAChunk, QARequest, QAResponse, RepoCreateRequest, RepoResponse


def _simple_local_answer(question: str, chunks: list[QAChunk]) -> str:
    """
    Local-first answer generation (no external LLM).

    This is intentionally lightweight: it returns an extractive answer that
    points the developer to the most relevant files/regions.
    """
    if not chunks:
        return "I couldn't find relevant code for that question in the ingested repo."

    top = chunks[:3]
    refs = "\n".join([f"- {c.path}:{c.start_line}-{c.end_line}" for c in top])
    return (
        "Local mode (no LLM configured).\n\n"
        f"Question: {question.strip()}\n\n"
        "Most relevant code locations:\n"
        f"{refs}\n\n"
        "Open the referenced files/lines and search within those chunks for the exact symbol/behavior."
    )


def create_app() -> FastAPI:
    app = FastAPI(
        title="AI Codebase Onboarding API",
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok", "environment": settings.environment}

    @app.post("/repos", response_model=RepoResponse)
    async def create_repo(
        body: RepoCreateRequest,
        background: BackgroundTasks,
        session: AsyncSession = Depends(get_db),
    ) -> RepoResponse:
        repo = Repo(url=body.url, status=RepoStatus.pending)
        session.add(repo)
        await session.commit()
        await session.refresh(repo)

        background.add_task(ingest_repo_job, repo.id)
        return RepoResponse.model_validate(repo, from_attributes=True)

    @app.get("/repos/{repo_id}", response_model=RepoResponse)
    async def get_repo(repo_id: uuid.UUID, session: AsyncSession = Depends(get_db)) -> RepoResponse:
        repo = await session.scalar(select(Repo).where(Repo.id == repo_id))
        if repo is None:
            raise HTTPException(status_code=404, detail="repo not found")
        return RepoResponse.model_validate(repo, from_attributes=True)

    @app.post("/qa", response_model=QAResponse)
    async def qa(body: QARequest, session: AsyncSession = Depends(get_db)) -> QAResponse:
        repo = await session.scalar(select(Repo).where(Repo.id == body.repo_id))
        if repo is None:
            raise HTTPException(status_code=404, detail="repo not found")
        if repo.status != RepoStatus.ready:
            raise HTTPException(status_code=409, detail=f"repo not ready (status={repo.status})")

        raw_chunks = await retrieve_chunks(session, repo.id, question=body.question, limit=8)
        chunks = [
            QAChunk(path=c.path, start_line=c.start_line, end_line=c.end_line, content=c.content)
            for c in raw_chunks
        ]

        # Local runnable default: extractive "answer" until an LLM is configured.
        if settings.openai_api_key:
            graph = build_qa_graph(openai_api_key=settings.openai_api_key, model=settings.openai_model)
            result = await graph.ainvoke(
                {
                    "question": body.question,
                    "chunks": [c.model_dump() for c in chunks],
                }
            )
            answer = str(result.get("answer") or "").strip() or "No answer returned."
        else:
            answer = _simple_local_answer(body.question, chunks)
        return QAResponse(
            answer=answer,
            chunks=chunks,
        )

    @app.post("/qa/stream")
    async def qa_stream(body: QARequest, session: AsyncSession = Depends(get_db)) -> StreamingResponse:
        if not settings.openai_api_key:
            raise HTTPException(status_code=400, detail="COAI_OPENAI_API_KEY is required for /qa/stream")

        repo = await session.scalar(select(Repo).where(Repo.id == body.repo_id))
        if repo is None:
            raise HTTPException(status_code=404, detail="repo not found")
        if repo.status != RepoStatus.ready:
            raise HTTPException(status_code=409, detail=f"repo not ready (status={repo.status})")

        run_id = str(uuid.uuid4())
        q: asyncio.Queue[dict] = asyncio.Queue()

        def emit(evt: dict) -> None:
            q.put_nowait(evt)

        async def retrieve(question: str) -> list[dict]:
            raw_chunks = await retrieve_chunks(session, repo.id, question=question, limit=8)
            return [
                {
                    "path": c.path,
                    "start_line": c.start_line,
                    "end_line": c.end_line,
                    "content": c.content,
                }
                for c in raw_chunks
            ]

        graph = build_multi_agent_qa_graph(
            openai_api_key=settings.openai_api_key,
            model=settings.openai_model,
            retrieve=retrieve,
            emit=emit,
        )

        async def runner() -> None:
            emit({"type": "run_started", "run_id": run_id})
            try:
                await graph.ainvoke({"run_id": run_id, "question": body.question})
            except Exception as e:  # noqa: BLE001
                emit({"type": "run_error", "run_id": run_id, "message": f"run_failed: {e}"})
            finally:
                emit({"type": "__end__", "run_id": run_id})

        task = asyncio.create_task(runner())

        async def event_iter():
            try:
                while True:
                    evt = await q.get()
                    if evt.get("type") == "__end__":
                        break
                    data = json.dumps(evt, ensure_ascii=False)
                    yield f"data: {data}\n\n"
            finally:
                task.cancel()

        return StreamingResponse(event_iter(), media_type="text/event-stream")

    return app


app = create_app()
