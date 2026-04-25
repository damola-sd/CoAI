"use client";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useMemo, useRef, useState } from "react";

type RepoResponse = {
  id: string;
  url: string;
  status: "pending" | "ingesting" | "ready" | "failed";
  error?: string | null;
};

type QAChunk = { path: string; start_line: number; end_line: number; content: string };
type AgentEvent =
  | { type: "run_started"; run_id: string }
  | { type: "agent_started"; run_id: string; agent: string }
  | { type: "agent_progress"; run_id: string; agent?: string; message?: string }
  | { type: "agent_finished"; run_id: string; agent: string }
  | {
      type: "final_result";
      run_id: string;
      data: { answer: string; chunks: QAChunk[]; followups?: string[]; plan?: string };
    }
  | { type: "run_error"; run_id: string; message?: string; agent?: string };

// In production we prefer same-origin requests (ALB routes /repos, /qa, etc. to the backend).
// Using a hardcoded localhost default breaks deployed builds because NEXT_PUBLIC_* values are
// inlined at build time.
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [repoZip, setRepoZip] = useState<File | null>(null);
  const [repo, setRepo] = useState<RepoResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [chunks, setChunks] = useState<QAChunk[]>([]);
  const [followups, setFollowups] = useState<string[]>([]);
  const [plan, setPlan] = useState<string | null>(null);
  const [activity, setActivity] = useState<Array<{ ts: number; text: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTokenRef = useRef(0);

  const canAsk = useMemo(() => repo?.status === "ready", [repo?.status]);

  const repoStatusPillClass =
    repo?.status === "ready"
      ? "bg-emerald-500/15 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300"
      : repo?.status === "ingesting"
        ? "bg-sky-500/15 text-sky-700 ring-sky-500/20 dark:text-sky-300"
        : repo?.status === "failed"
          ? "bg-rose-500/15 text-rose-700 ring-rose-500/20 dark:text-rose-300"
          : "bg-amber-500/15 text-amber-800 ring-amber-500/20 dark:text-amber-200";

  async function refreshRepo(repoIdOverride?: string) {
    const id = repoIdOverride ?? repo?.id;
    if (!id) return;
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/repos/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as RepoResponse;
      setRepo(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function pollRepoUntilReady(repoId: string) {
    const token = ++pollTokenRef.current;
    for (let i = 0; i < 120; i++) {
      if (pollTokenRef.current !== token) return; // superseded
      await refreshRepo(repoId);
      // We can't rely on state immediately after setRepo, so fetch status directly too:
      try {
        const res = await fetch(`${API_BASE_URL}/repos/${repoId}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as RepoResponse;
          setRepo(data);
          if (data.status === "ready" || data.status === "failed") return;
        }
      } catch {
        // ignore transient errors during polling
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function createRepo() {
    setError(null);
    setAnswer(null);
    setChunks([]);
    setFollowups([]);
    setPlan(null);
    setActivity([]);
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
      void pollRepoUntilReady(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function uploadRepoZip() {
    if (!repoZip) return;
    setError(null);
    setAnswer(null);
    setChunks([]);
    setFollowups([]);
    setPlan(null);
    setActivity([]);
    setRepo(null);
    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", repoZip, repoZip.name);
      const res = await fetch(`${API_BASE_URL}/repos/upload`, { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as RepoResponse;
      setRepo(data);
      void pollRepoUntilReady(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function ask(qOverride?: string) {
    if (!repo) return;
    const qText = (qOverride ?? question).trim();
    if (!qText) return;
    setError(null);
    setAnswer(null);
    setChunks([]);
    setFollowups([]);
    setPlan(null);
    setActivity([]);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/qa/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo_id: repo.id, question: qText }),
      });
      if (!res.ok) throw new Error(await res.text());

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body (stream not supported).");

      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames separated by blank line
        while (true) {
          const sep = buffer.indexOf("\n\n");
          if (sep === -1) break;
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          const dataLine = frame
            .split("\n")
            .map((l) => l.trimEnd())
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const jsonStr = dataLine.replace(/^data:\s?/, "");

          let evt: AgentEvent | null = null;
          try {
            evt = JSON.parse(jsonStr) as AgentEvent;
          } catch {
            continue;
          }

          const now = Date.now();
          if (evt.type === "run_started") {
            setActivity((a) => [...a, { ts: now, text: "Run started" }]);
          } else if (evt.type === "agent_started") {
            setActivity((a) => [...a, { ts: now, text: `${evt.agent} started` }]);
          } else if (evt.type === "agent_progress") {
            setActivity((a) => [
              ...a,
              { ts: now, text: `${evt.agent ?? "agent"}: ${evt.message ?? "working..."}` },
            ]);
          } else if (evt.type === "agent_finished") {
            setActivity((a) => [...a, { ts: now, text: `${evt.agent} finished` }]);
          } else if (evt.type === "run_error") {
            setActivity((a) => [
              ...a,
              { ts: now, text: `error${evt.agent ? ` (${evt.agent})` : ""}: ${evt.message ?? ""}` },
            ]);
          } else if (evt.type === "final_result") {
            setAnswer(evt.data.answer);
            setChunks(evt.data.chunks);
            setFollowups(evt.data.followups ?? []);
            setPlan(evt.data.plan ?? null);
            setActivity((a) => [...a, { ts: now, text: "Final result received" }]);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function askFollowup(f: string) {
    if (!canAsk || loading) return;
    const q = f.trim();
    if (!q) return;
    setQuestion(q);
    await ask(q);
  }

  return (
    <div className="relative flex flex-1 flex-col items-center overflow-hidden bg-gradient-to-br from-fuchsia-50 via-white to-sky-50 px-6 py-10 font-sans text-zinc-900 dark:from-zinc-950 dark:via-zinc-950 dark:to-slate-950 dark:text-zinc-50">
      <div className="pointer-events-none absolute -top-24 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-fuchsia-400/30 via-violet-400/25 to-sky-400/30 blur-3xl dark:from-fuchsia-500/15 dark:via-violet-500/15 dark:to-sky-500/15" />
      <div className="pointer-events-none absolute -bottom-32 right-[-120px] h-[520px] w-[520px] rounded-full bg-gradient-to-tr from-emerald-400/20 via-cyan-400/15 to-sky-400/20 blur-3xl dark:from-emerald-500/10 dark:via-cyan-500/10 dark:to-sky-500/10" />

      <main className="relative w-full max-w-5xl space-y-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/40 bg-white/50 px-3 py-1 text-xs font-medium text-zinc-700 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-zinc-200">
              <span className="h-2 w-2 rounded-full bg-gradient-to-r from-fuchsia-500 to-sky-500" />
              COAI
              <span className="text-zinc-500 dark:text-zinc-400">• AI Codebase Onboarding</span>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Ask better questions.
              <span className="block bg-gradient-to-r from-fuchsia-600 via-violet-600 to-sky-600 bg-clip-text text-transparent dark:from-fuchsia-400 dark:via-violet-400 dark:to-sky-400">
                Get grounded answers.
              </span>
            </h1>
            <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
              Ingest a repository (Git URL or ZIP), then query it with retrieval + agentic reasoning.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden rounded-xl border border-white/40 bg-white/50 px-3 py-2 text-xs text-zinc-600 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-zinc-300 sm:block">
              API base: <span className="font-mono text-zinc-800 dark:text-zinc-100">{API_BASE_URL || "(same origin)"}</span>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-white/60 bg-white/60 p-5 shadow-[0_12px_40px_-20px_rgba(0,0,0,0.25)] backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-6">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">1) Ingest a repo</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                Create an index once, then ask questions instantly.
              </p>
            </div>

            {repo ? (
              <div className="mt-2 inline-flex items-center gap-2 self-start sm:mt-0 sm:self-auto">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${repoStatusPillClass}`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                  {repo.status}
                </span>
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              className="flex-1 rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-sm shadow-sm outline-none backdrop-blur transition focus:border-violet-300 focus:ring-4 focus:ring-violet-200/60 dark:border-white/10 dark:bg-white/5 dark:focus:border-violet-500/40 dark:focus:ring-violet-500/20"
              placeholder="https://github.com/org/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <button
              className="rounded-2xl bg-gradient-to-r from-fuchsia-600 via-violet-600 to-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
              onClick={createRepo}
              disabled={loading || repoUrl.trim().length === 0}
            >
              Create + ingest
            </button>
            <button
              className="rounded-2xl border border-white/60 bg-white/60 px-4 py-3 text-sm font-semibold text-zinc-800 shadow-sm backdrop-blur transition hover:bg-white/80 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100 dark:hover:bg-white/10"
              onClick={() => refreshRepo()}
              disabled={loading || !repo}
              title="Refresh status"
            >
              Refresh
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="file"
              accept=".zip"
              className="flex-1 rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-sm shadow-sm outline-none backdrop-blur transition file:mr-3 file:rounded-xl file:border-0 file:bg-white/70 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-zinc-800 hover:file:bg-white/90 dark:border-white/10 dark:bg-white/5 dark:file:bg-white/10 dark:file:text-zinc-100 dark:hover:file:bg-white/15"
              onChange={(e) => setRepoZip(e.target.files?.[0] ?? null)}
              disabled={loading}
            />
            <button
              className="rounded-2xl bg-gradient-to-r from-emerald-600 via-cyan-600 to-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
              onClick={uploadRepoZip}
              disabled={loading || !repoZip}
              title="Upload a .zip of your repo"
            >
              Upload + ingest (.zip)
            </button>
          </div>

          {repo ? (
            <div className="mt-5 rounded-2xl border border-white/60 bg-white/60 p-4 text-sm shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
              <div className="flex flex-col gap-1">
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Repo ID:</span>{" "}
                  <span className="font-mono">{repo.id}</span>
                </div>
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Status:</span>{" "}
                  <span className="font-semibold">{repo.status}</span>
                </div>
                {repo.error ? (
                  <div className="text-rose-700 dark:text-rose-300">
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

        <section className="rounded-3xl border border-white/60 bg-white/60 p-5 shadow-[0_12px_40px_-20px_rgba(0,0,0,0.25)] backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-6">
          <h2 className="text-lg font-semibold">2) Ask a question</h2>
          <div className="mt-4 flex flex-col gap-3">
            <textarea
              className="min-h-[96px] w-full rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-sm shadow-sm outline-none backdrop-blur transition focus:border-violet-300 focus:ring-4 focus:ring-violet-200/60 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:focus:border-violet-500/40 dark:focus:ring-violet-500/20"
              placeholder="e.g. Where is authentication handled?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!canAsk || loading}
            />
            <div className="flex items-center gap-3">
              <button
                className="rounded-2xl bg-gradient-to-r from-fuchsia-600 via-violet-600 to-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
                onClick={() => ask()}
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

          {activity.length ? (
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Agent activity
              </h3>
              <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="max-h-48 space-y-1 overflow-auto font-mono text-xs text-zinc-700 dark:text-zinc-200">
                  {activity.map((a, idx) => (
                    <div key={`${a.ts}:${idx}`} className="whitespace-pre-wrap">
                      {a.text}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {plan ? (
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Plan</h3>
              <div className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    pre: ({ children, ...props }: { children?: React.ReactNode }) => (
                      <pre
                        {...props}
                        className="overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-950"
                      >
                        {children}
                      </pre>
                    ),
                    code: ({
                      className,
                      children,
                      ...props
                    }: {
                      className?: string;
                      children?: React.ReactNode;
                    }) => (
                      // `rehype-highlight` typically sets `className="hljs language-..."` on fenced blocks.
                      <code
                        {...props}
                        className={
                          className?.includes("language-")
                            ? `hljs ${className} block font-mono`
                            : "rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-950"
                        }
                      >
                        {children}
                      </code>
                    ),
                  }}
                >
                  {plan}
                </ReactMarkdown>
              </div>
            </div>
          ) : null}

          {answer ? (
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Answer</h3>
              <div className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    pre: ({ children, ...props }: { children?: React.ReactNode }) => (
                      <pre
                        {...props}
                        className="overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-950"
                      >
                        {children}
                      </pre>
                    ),
                    code: ({
                      className,
                      children,
                      ...props
                    }: {
                      className?: string;
                      children?: React.ReactNode;
                    }) => (
                      // `rehype-highlight` typically sets `className="hljs language-..."` on fenced blocks.
                      <code
                        {...props}
                        className={
                          className?.includes("language-")
                            ? `hljs ${className} block font-mono`
                            : "rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-950"
                        }
                      >
                        {children}
                      </code>
                    ),
                  }}
                >
                  {answer}
                </ReactMarkdown>
              </div>
            </div>
          ) : null}

          {followups.length ? (
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Follow-ups</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-900 dark:text-zinc-50">
                {followups.map((f, idx) => (
                  <li key={`${idx}:${f}`}>
                    <button
                      type="button"
                      className="text-left underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500 disabled:opacity-50 dark:decoration-zinc-700 dark:hover:decoration-zinc-400"
                      onClick={() => askFollowup(f)}
                      disabled={!canAsk || loading}
                      title="Ask this follow-up"
                    >
                      {f}
                    </button>
                  </li>
                ))}
              </ul>
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
