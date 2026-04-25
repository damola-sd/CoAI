from __future__ import annotations

"""
Phase 2: minimal LangGraph wiring scaffold.

We keep this package separate so later phases can evolve orchestration
without entangling the FastAPI service.
"""

from typing import Any, TypedDict

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

