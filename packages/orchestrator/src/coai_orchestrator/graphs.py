from __future__ import annotations

"""
Phase 2: minimal LangGraph wiring scaffold.

We keep this package separate so later phases can evolve orchestration
without entangling the FastAPI service.
"""

from typing import Any, Awaitable, Callable, Literal, TypedDict

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


EventType = Literal[
    "run_started",
    "agent_started",
    "agent_progress",
    "agent_finished",
    "final_result",
    "run_error",
]


class QAEvent(TypedDict, total=False):
    type: EventType
    run_id: str
    agent: str
    message: str
    data: dict[str, Any]


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


class MultiAgentQAState(TypedDict, total=False):
    run_id: str
    question: str
    chunks: list[QAChunk]
    plan: str
    draft_answer: str
    answer: str
    followups: list[str]
    error: str


def build_multi_agent_qa_graph(
    *,
    openai_api_key: str,
    model: str,
    retrieve: Callable[[str], Awaitable[list[QAChunk]]] | None = None,
    emit: Callable[[QAEvent], None] | None = None,
) -> Any:
    """
    Multi-agent pipeline for QA:
    planner -> retriever -> explainer -> critic -> followups -> END

    `emit` is used to stream structured events to the caller (e.g. backend SSE).
    """

    def _emit(evt: QAEvent) -> None:
        if emit is not None:
            emit(evt)

    graph: StateGraph = StateGraph(MultiAgentQAState)
    client = AsyncOpenAI(api_key=openai_api_key)

    async def planner_node(state: MultiAgentQAState) -> MultiAgentQAState:
        run_id = state.get("run_id", "")
        _emit({"type": "agent_started", "run_id": run_id, "agent": "planner"})

        question = (state.get("question") or "").strip()
        if not question:
            return {**state, "plan": "", "error": "empty_question"}

        system = (
            "You are an expert software engineer. Create a short, actionable investigation plan.\n"
            "Keep it to 3-6 bullet points. Do not include code; focus on what to inspect/search.\n"
        )
        user = f"Question:\n{question}"
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                temperature=0.2,
            )
            plan = (resp.choices[0].message.content or "").strip()
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "planner"})
            return {**state, "plan": plan}
        except Exception as e:  # noqa: BLE001
            _emit(
                {
                    "type": "run_error",
                    "run_id": run_id,
                    "agent": "planner",
                    "message": f"planner_failed: {e}",
                }
            )
            return {**state, "error": f"planner_failed: {e}", "plan": ""}

    async def retriever_node(state: MultiAgentQAState) -> MultiAgentQAState:
        run_id = state.get("run_id", "")
        _emit({"type": "agent_started", "run_id": run_id, "agent": "retriever"})

        if state.get("chunks"):
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "retriever"})
            return state

        if retrieve is None:
            _emit({"type": "agent_progress", "run_id": run_id, "agent": "retriever", "message": "No retriever configured."})
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "retriever"})
            return {**state, "chunks": []}

        try:
            q = (state.get("question") or "").strip()
            chunks = await retrieve(q)
            _emit(
                {
                    "type": "agent_progress",
                    "run_id": run_id,
                    "agent": "retriever",
                    "message": f"Retrieved {len(chunks)} chunks.",
                }
            )
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "retriever"})
            return {**state, "chunks": chunks}
        except Exception as e:  # noqa: BLE001
            _emit(
                {
                    "type": "run_error",
                    "run_id": run_id,
                    "agent": "retriever",
                    "message": f"retrieve_failed: {e}",
                }
            )
            return {**state, "chunks": [], "error": f"retrieve_failed: {e}"}

    async def explainer_node(state: MultiAgentQAState) -> MultiAgentQAState:
        run_id = state.get("run_id", "")
        _emit({"type": "agent_started", "run_id": run_id, "agent": "explainer"})

        question = (state.get("question") or "").strip()
        chunks = state.get("chunks") or []

        if not question:
            return {**state, "draft_answer": "Please provide a non-empty question."}
        if not chunks:
            return {
                **state,
                "draft_answer": "I couldn't find relevant code for that question in the ingested repo.",
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
            "Cite sources as [1], [2], etc.\n"
            "Be concise but specific; point to the exact files/classes/functions where possible."
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
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                temperature=0.2,
            )
            draft = (resp.choices[0].message.content or "").strip()
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "explainer"})
            return {**state, "draft_answer": draft or "No answer returned by the model."}
        except Exception as e:  # noqa: BLE001
            _emit(
                {
                    "type": "run_error",
                    "run_id": run_id,
                    "agent": "explainer",
                    "message": f"openai_failed: {e}",
                }
            )
            return {**state, "error": f"openai_failed: {e}", "draft_answer": "LLM call failed."}

    async def critic_node(state: MultiAgentQAState) -> MultiAgentQAState:
        run_id = state.get("run_id", "")
        _emit({"type": "agent_started", "run_id": run_id, "agent": "critic"})

        question = (state.get("question") or "").strip()
        draft = (state.get("draft_answer") or "").strip()
        chunks = state.get("chunks") or []

        if not draft:
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "critic"})
            return {**state, "answer": draft}

        refs = "\n".join([f"- [{i}] {c['path']}:{c['start_line']}-{c['end_line']}" for i, c in enumerate(chunks, start=1)])

        system = (
            "You are a meticulous reviewer. Improve the draft answer for correctness and clarity.\n"
            "Rules:\n"
            "- Keep claims grounded in the provided chunk citations.\n"
            "- If a claim lacks a citation, remove it or qualify it.\n"
            "- Ensure the final answer includes citations like [1].\n"
            "- Output only the revised final answer."
        )
        user = "\n\n".join(
            [
                f"Question:\n{question}",
                "Available citations:",
                refs or "(no chunks)",
                "Draft answer:",
                draft,
            ]
        )

        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                temperature=0.2,
            )
            final_answer = (resp.choices[0].message.content or "").strip()
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "critic"})
            return {**state, "answer": final_answer or draft}
        except Exception as e:  # noqa: BLE001
            _emit(
                {
                    "type": "run_error",
                    "run_id": run_id,
                    "agent": "critic",
                    "message": f"critic_failed: {e}",
                }
            )
            return {**state, "error": f"critic_failed: {e}", "answer": draft}

    async def followups_node(state: MultiAgentQAState) -> MultiAgentQAState:
        run_id = state.get("run_id", "")
        _emit({"type": "agent_started", "run_id": run_id, "agent": "followups"})

        question = (state.get("question") or "").strip()
        answer = (state.get("answer") or state.get("draft_answer") or "").strip()

        system = (
            "Generate 3 short follow-up questions a developer might ask next.\n"
            "Each should be specific and actionable. Return as a JSON array of strings."
        )
        user = "\n\n".join(
            [
                f"Original question:\n{question}",
                f"Current answer:\n{answer}",
            ]
        )
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                temperature=0.3,
            )
            raw = (resp.choices[0].message.content or "").strip()
            # Keep parsing permissive: if not JSON, fall back to line splitting.
            followups: list[str]
            try:
                import json  # local import to keep module surface small

                parsed = json.loads(raw)
                followups = [str(x).strip() for x in parsed if str(x).strip()]
            except Exception:  # noqa: BLE001
                followups = [line.strip("- ").strip() for line in raw.splitlines() if line.strip()]

            followups = followups[:3]
            _emit({"type": "agent_finished", "run_id": run_id, "agent": "followups"})
            return {**state, "followups": followups}
        except Exception as e:  # noqa: BLE001
            _emit(
                {
                    "type": "run_error",
                    "run_id": run_id,
                    "agent": "followups",
                    "message": f"followups_failed: {e}",
                }
            )
            return {**state, "error": f"followups_failed: {e}", "followups": []}

    async def final_node(state: MultiAgentQAState) -> MultiAgentQAState:
        run_id = state.get("run_id", "")
        result = {
            "answer": (state.get("answer") or state.get("draft_answer") or "").strip(),
            "chunks": state.get("chunks") or [],
            "followups": state.get("followups") or [],
            "plan": (state.get("plan") or "").strip(),
        }
        _emit({"type": "final_result", "run_id": run_id, "data": result})
        return {**state, "answer": result["answer"]}

    graph.add_node("planner", planner_node)
    graph.add_node("retriever", retriever_node)
    graph.add_node("explainer", explainer_node)
    graph.add_node("critic", critic_node)
    graph.add_node("followups", followups_node)
    graph.add_node("final", final_node)

    graph.set_entry_point("planner")
    graph.add_edge("planner", "retriever")
    graph.add_edge("retriever", "explainer")
    graph.add_edge("explainer", "critic")
    graph.add_edge("critic", "followups")
    graph.add_edge("followups", "final")
    graph.add_edge("final", END)

    return graph.compile()

