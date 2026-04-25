from __future__ import annotations

"""
Phase 2: minimal LangGraph wiring scaffold.

We keep this package separate so later phases can evolve orchestration
without entangling the FastAPI service.
"""

from typing import Any, Awaitable, Callable, TypedDict

from openai import AsyncOpenAI

from langgraph.graph import END, StateGraph


class IngestState(TypedDict, total=False):
    repo_id: str
    status: str
    error: str


def build_ingest_graph() -> Any:
    graph = StateGraph(IngestState)

    def start(state: IngestState) -> IngestState:
        return {**state, "status": "started"}

    graph.add_node("start", start)
    graph.set_entry_point("start")
    graph.add_edge("start", END)
    return graph.compile()


class QAChunk(TypedDict):
    path: str
    start_line: int
    end_line: int
    content: str


class QAState(TypedDict, total=False):
    question: str
    chunks: list[QAChunk]
    answer: str
    error: str


def build_qa_graph(
    *,
    openai_api_key: str,
    model: str,
    retrieve: Callable[[str], Awaitable[list[QAChunk]]] | None = None,
) -> Any:
    """
    Minimal QA orchestration: retrieve (optional) -> answer (OpenAI).

    `retrieve` is dependency-injected so the backend can decide how/where to
    retrieve context (e.g. Postgres, vector DB) without coupling this package
    to the storage layer.
    """

    graph: StateGraph = StateGraph(QAState)
    client = AsyncOpenAI(api_key=openai_api_key)

    async def retrieve_node(state: QAState) -> QAState:
        if state.get("chunks"):
            return state
        if retrieve is None:
            return {**state, "chunks": []}
        try:
            chunks = await retrieve(state.get("question", "").strip())
            return {**state, "chunks": chunks}
        except Exception as e:  # noqa: BLE001
            return {**state, "chunks": [], "error": f"retrieve_failed: {e}"}

    async def answer_node(state: QAState) -> QAState:
        question = (state.get("question") or "").strip()
        chunks = state.get("chunks") or []

        if not question:
            return {**state, "answer": "Please provide a non-empty question."}
        if not chunks:
            return {
                **state,
                "answer": "I couldn't find relevant code for that question in the ingested repo.",
            }

        context_blocks: list[str] = []
        for i, c in enumerate(chunks, start=1):
            context_blocks.append(
                "\n".join(
                    [
                        f"[{i}] {c['path']}:{c['start_line']}-{c['end_line']}",
                        c["content"],
                    ]
                )
            )

        system = (
            "You are a senior software engineer helping a developer understand a codebase.\n"
            "Answer the user's question using ONLY the provided code context.\n"
            "When you reference a fact, cite the chunk like [1] or [2].\n"
            "If the context is insufficient, say what is missing and what to search for next."
        )
        user = "\n\n".join(
            [
                f"Question:\n{question}",
                "Code context:",
                "\n\n---\n\n".join(context_blocks),
            ]
        )

        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=0.2,
            )
            content = (resp.choices[0].message.content or "").strip()
            return {**state, "answer": content or "No answer returned by the model."}
        except Exception as e:  # noqa: BLE001
            return {**state, "error": f"openai_failed: {e}", "answer": "LLM call failed."}

    graph.add_node("retrieve", retrieve_node)
    graph.add_node("answer", answer_node)

    graph.set_entry_point("retrieve")
    graph.add_edge("retrieve", "answer")
    graph.add_edge("answer", END)
    return graph.compile()

