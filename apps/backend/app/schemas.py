from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from .models import RepoStatus


class RepoCreateRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class RepoResponse(BaseModel):
    id: uuid.UUID
    url: str
    status: RepoStatus
    error: str | None = None
    created_at: datetime
    updated_at: datetime


class QARequest(BaseModel):
    repo_id: uuid.UUID
    question: str = Field(min_length=1, max_length=8000)


class QAChunk(BaseModel):
    path: str
    start_line: int
    end_line: int
    content: str


class QAResponse(BaseModel):
    answer: str
    chunks: list[QAChunk]
