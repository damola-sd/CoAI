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
      const st = (repoId === repo?.id ? repo?.status : undefined) ?? undefined;
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
              className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-950 dark:file:bg-zinc-900 dark:hover:file:bg-zinc-800"
              onChange={(e) => setRepoZip(e.target.files?.[0] ?? null)}
              disabled={loading}
            />
            <button
              className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white"
              onClick={uploadRepoZip}
              disabled={loading || !repoZip}
              title="Upload a .zip of your repo"
            >
              Upload + ingest (.zip)
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
