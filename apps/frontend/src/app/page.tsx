"use client";

import { useMemo, useState } from "react";

type RepoResponse = {
  id: string;
  url: string;
  status: "pending" | "ingesting" | "ready" | "failed";
  error?: string | null;
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8000";

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [repo, setRepo] = useState<RepoResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [chunks, setChunks] = useState<
    Array<{ path: string; start_line: number; end_line: number; content: string }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canAsk = useMemo(() => repo?.status === "ready", [repo?.status]);

  async function createRepo() {
    setError(null);
    setAnswer(null);
    setChunks([]);
    setRepo(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/repos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: repoUrl.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as RepoResponse;
      setRepo(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshRepo() {
    if (!repo) return;
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/repos/${repo.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as RepoResponse;
      setRepo(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function ask() {
    if (!repo) return;
    setError(null);
    setAnswer(null);
    setChunks([]);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/qa`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo_id: repo.id, question: question.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as {
        answer: string;
        chunks: Array<{ path: string; start_line: number; end_line: number; content: string }>;
      };
      setAnswer(data.answer);
      setChunks(data.chunks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="w-full max-w-4xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">AI Codebase Onboarding (Local)</h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Ingest a git repo, then ask questions with grounded code context (no API keys required).
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            API base URL: <span className="font-mono">{API_BASE_URL}</span>
          </p>
        </header>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">1) Ingest a repo</h2>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:ring-zinc-700"
              placeholder="https://github.com/org/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <button
              className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white"
              onClick={createRepo}
              disabled={loading || repoUrl.trim().length === 0}
            >
              Create + ingest
            </button>
            <button
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
              onClick={refreshRepo}
              disabled={loading || !repo}
              title="Refresh status"
            >
              Refresh
            </button>
          </div>

          {repo ? (
            <div className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm dark:bg-zinc-900">
              <div className="flex flex-col gap-1">
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Repo ID:</span>{" "}
                  <span className="font-mono">{repo.id}</span>
                </div>
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Status:</span>{" "}
                  <span className="font-medium">{repo.status}</span>
                </div>
                {repo.error ? (
                  <div className="text-red-600 dark:text-red-400">
                    <span className="text-zinc-500 dark:text-zinc-400">Error:</span> {repo.error}
                  </div>
                ) : null}
              </div>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                Tip: ingestion can take a bit depending on repo size. Hit “Refresh” until status is{" "}
                <span className="font-medium">ready</span>.
              </p>
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">2) Ask a question</h2>
          <div className="mt-4 flex flex-col gap-3">
            <textarea
              className="min-h-[90px] w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:ring-zinc-700"
              placeholder="e.g. Where is authentication handled?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!canAsk || loading}
            />
            <div className="flex items-center gap-3">
              <button
                className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white"
                onClick={ask}
                disabled={!canAsk || loading || question.trim().length === 0}
              >
                Ask
              </button>
              {!repo ? (
                <span className="text-sm text-zinc-500 dark:text-zinc-400">Create a repo first.</span>
              ) : repo.status !== "ready" ? (
                <span className="text-sm text-zinc-500 dark:text-zinc-400">
                  Repo must be <span className="font-medium">ready</span> to ask questions.
                </span>
              ) : null}
            </div>
          </div>

          {answer ? (
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Answer</h3>
              <pre className="whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">
                {answer}
              </pre>
            </div>
          ) : null}

          {chunks.length ? (
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Retrieved chunks
              </h3>
              <div className="space-y-3">
                {chunks.map((c, idx) => (
                  <div
                    key={`${c.path}:${c.start_line}:${idx}`}
                    className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="font-mono">{c.path}</span> • {c.start_line}-{c.end_line}
                    </div>
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre rounded-lg bg-zinc-50 p-3 text-xs text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">
                      {c.content}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <div className="font-medium">Error</div>
            <pre className="mt-2 whitespace-pre-wrap text-xs">{error}</pre>
          </div>
        ) : null}
      </main>
    </div>
  );
}
