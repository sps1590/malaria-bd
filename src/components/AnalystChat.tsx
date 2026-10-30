"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AnalystMap, DataChart, DataTable, tableToCsv } from "@/components/AnalystViz";
import { MarkdownText } from "@/components/MarkdownText";
import { STARTERS } from "@/lib/analyst/catalog";
import type { AnalystContext, AnalystEvent, AnalystReply } from "@/lib/analyst/types";

interface UserMsg { id: number; role: "user"; text: string }
interface BotMsg {
  id: number;
  role: "assistant";
  /** Progress lines streamed while the server works. */
  steps: string[];
  reply?: AnalystReply;
  error?: string;
  /** Animate the text in (only for answers that arrive live, not restored ones). */
  live: boolean;
}
type Msg = UserMsg | BotMsg;

const STORE_KEY = "mis-analyst-chat-v2";

/** Close any unfinished bold/code marker so half-typed Markdown does not flicker. */
function balance(partial: string): string {
  let s = partial;
  if ((s.match(/\*\*/g) ?? []).length % 2) s += "**";
  if ((s.match(/`/g) ?? []).length % 2) s += "`";
  return s;
}

function useTypewriter(text: string, animate: boolean): { shown: string; done: boolean } {
  const [state, setState] = useState({ text, n: animate ? 0 : text.length });
  const n = state.text === text ? state.n : animate ? 0 : text.length;
  const done = n >= text.length;
  useEffect(() => {
    if (!animate || done) return;
    const step = Math.max(3, Math.ceil(text.length / 140));
    const id = setInterval(() => setState((s) => ({ text, n: Math.min(text.length, (s.text === text ? s.n : 0) + step) })), 16);
    return () => clearInterval(id);
  }, [text, animate, done]);
  return { shown: done ? text : text.slice(0, n), done };
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

function downloadCsv(reply: AnalystReply) {
  if (!reply.table) return;
  const blob = new Blob([`﻿${tableToCsv(reply.table)}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mis-analyst-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Thinking({ steps }: { steps: string[] }) {
  return (
    <div className="space-y-1.5 text-sm text-slate-500" role="status">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <div key={i} className="flex items-center gap-2">
            {last ? <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" /> : <span className="text-emerald-600">✓</span>}
            <span className={last ? "text-slate-700" : ""}>{s}{last ? "…" : ""}</span>
          </div>
        );
      })}
      {steps.length === 0 && (
        <div className="flex items-center gap-2"><span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" /> Thinking…</div>
      )}
    </div>
  );
}

function AssistantBubble({ msg, onAsk, isLast, busy }: { msg: BotMsg; onAsk: (q: string) => void; isLast: boolean; busy: boolean }) {
  const reply = msg.reply;
  const { shown, done } = useTypewriter(reply?.text ?? "", msg.live);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [showSql, setShowSql] = useState(false);

  if (msg.error) return <p className="text-sm text-rose-700">{msg.error}</p>;
  if (!reply) return <Thinking steps={msg.steps} />;

  const hasMap = !!reply.map && reply.map.rows.length > 0;
  const hasChart = !hasMap && !!reply.chart && reply.chart.rows.length > 0;
  const hasVisual = hasMap || hasChart;
  const hasTable = !!reply.table && reply.table.rows.length > 0;
  const refusal = reply.kind === "refusal";

  return (
    <div className="space-y-3">
      {reply.interpretation.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="How I understood the question">
          {reply.interpretation.map((c) => (
            <span key={c.label} className="rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-900">
              <span className="text-indigo-500">{c.label}:</span> {c.value}
            </span>
          ))}
        </div>
      )}

      <div className={refusal ? "rounded-lg border border-amber-200 bg-amber-50 p-3" : ""}>
        <MarkdownText text={balance(shown)} />
      </div>

      {done && (hasVisual || hasTable) && (
        <div className="space-y-2">
          {hasVisual && hasTable && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-700">{hasMap ? "Map and table of the same figures" : reply.chart!.title}</p>
              <div className="flex overflow-hidden rounded-md border border-slate-200 text-[11px]">
                {(["chart", "table"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setView(v)} className={`px-2.5 py-1 ${view === v ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                    {v === "chart" ? (hasMap ? "Map" : "Chart") : "Table"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {hasMap && (view === "chart" || !hasTable) && <AnalystMap map={reply.map!} />}
          {hasChart && (view === "chart" || !hasTable) && (
            <div className="rounded-lg border border-slate-200 bg-white p-2">
              {!hasTable && <p className="px-1 pb-1 text-xs font-semibold text-slate-700">{reply.chart!.title}</p>}
              <DataChart chart={reply.chart!} />
            </div>
          )}
          {hasTable && (view === "table" || !hasVisual) && <DataTable table={reply.table!} />}
        </div>
      )}

      {done && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {reply.sql.length > 0 && (
            <button type="button" onClick={() => setShowSql((s) => !s)} className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-slate-600 hover:bg-slate-50">
              {showSql ? "Hide" : "How I got this"} · {reply.sql.length} read-only {reply.sql.length === 1 ? "query" : "queries"}
            </button>
          )}
          <CopyButton text={reply.text.replace(/[*_`#]/g, "")} label="Copy answer" />
          {hasTable && (
            <button type="button" onClick={() => downloadCsv(reply)} className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-slate-600 hover:bg-slate-50">
              Download CSV
            </button>
          )}
          {reply.kind === "answer" && reply.ms > 0 && <span>{reply.rowCount > 0 ? `${reply.rowCount.toLocaleString("en-US")} rows scanned · ` : ""}{reply.ms} ms</span>}
        </div>
      )}

      {done && showSql && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500">Every query runs inside a <b>READ ONLY</b> database transaction with a 10-second limit. Values shown inline here are sent as bound parameters.</p>
          {reply.sql.map((q, i) => (
            <div key={i} className="relative rounded-lg bg-slate-900 p-3">
              <div className="absolute right-2 top-2"><CopyButton text={q} /></div>
              <pre className="overflow-x-auto pr-16 text-[11px] leading-relaxed text-slate-100">{q}</pre>
            </div>
          ))}
        </div>
      )}

      {done && isLast && !busy && reply.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {reply.suggestions.map((s) => (
            <button key={s} type="button" onClick={() => onAsk(s)} className="rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs text-indigo-800 hover:bg-indigo-50">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AnalystChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ready: boolean; latest?: string; years?: string } | null>(null);
  const ctxRef = useRef<AnalystContext | null>(null);
  const idRef = useRef(1);
  const contentRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const ownTop = useRef(-1);
  const [ideas, setIdeas] = useState(false);

  // restore the conversation (the tab unmounts when you switch tabs)
  useEffect(() => {
    // read synchronously (before the save effect below can overwrite it), apply on the next microtask
    let restored: Msg[] = [];
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { messages: Msg[]; context: AnalystContext | null };
        restored = saved.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => (m.role === "assistant" ? { ...m, live: false } : m)) as Msg[];
        idRef.current = restored.reduce((mx, m) => Math.max(mx, m.id), 0) + 1;
        ctxRef.current = saved.context;
      }
    } catch { /* storage unavailable or corrupt: start fresh */ }
    queueMicrotask(() => {
      if (restored.length) setMessages(restored);
      hydrated.current = true;
    });
    fetch("/api/agent")
      .then((r) => r.json())
      .then((j: { ready: boolean; latest?: string; years?: string }) => setStatus(j))
      .catch(() => setStatus({ ready: false }));
  }, []);

  useEffect(() => {
    if (busy || !hydrated.current) return;
    try {
      const done = messages.filter((m) => m.role === "user" || m.reply || m.error);
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ messages: done.slice(-40), context: ctxRef.current }));
    } catch { /* ignore */ }
  }, [messages, busy]);

  // keep the newest text in view while an answer types in or a chart renders (unless the reader scrolled up)
  useEffect(() => {
    const box = scroller.current;
    const content = contentRef.current;
    if (!box || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current && content.dataset.chat === "1") {
        box.scrollTop = box.scrollHeight;
        ownTop.current = box.scrollTop; // the scroll event this causes must not count as the reader scrolling away
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const patchBot = useCallback((id: number, fn: (m: BotMsg) => BotMsg) => {
    setMessages((all) => all.map((m) => (m.id === id && m.role === "assistant" ? fn(m) : m)));
  }, []);

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;
      setIdeas(false);
      const userId = idRef.current++;
      const botId = idRef.current++;
      stick.current = true;
      setMessages((m) => [...m.map((x) => (x.role === "assistant" ? { ...x, live: false } : x)), { id: userId, role: "user", text: question }, { id: botId, role: "assistant", steps: [], live: true }]);
      setInput("");
      setBusy(true);
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, context: ctxRef.current }),
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          patchBot(botId, (m) => ({ ...m, error: j?.error ?? `Request failed (${res.status}).` }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
            if (!line) continue;
            const ev = JSON.parse(line) as AnalystEvent;
            if (ev.t === "step") patchBot(botId, (m) => ({ ...m, steps: [...m.steps, ev.label] }));
            else if (ev.t === "reply") {
              ctxRef.current = ev.reply.context ?? ctxRef.current;
              patchBot(botId, (m) => ({ ...m, reply: ev.reply }));
            } else if (ev.t === "error") patchBot(botId, (m) => ({ ...m, error: ev.message }));
          }
        }
        patchBot(botId, (m) => (m.reply || m.error ? m : { ...m, error: "The connection closed before I could finish. Please try again." }));
      } catch {
        patchBot(botId, (m) => ({ ...m, error: "Connection error — please try again." }));
      } finally {
        setBusy(false);
      }
    },
    [busy, patchBot],
  );

  const reset = () => {
    setMessages([]);
    ctxRef.current = null;
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };

  const lastUser = [...messages].reverse().find((m): m is UserMsg => m.role === "user")?.text;
  const lastBotId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="flex h-[calc(100vh-12rem)] min-h-[560px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-slate-900 to-indigo-900 px-4 py-3 text-white">
        <div>
          <h2 className="text-sm font-semibold">MIS Analyst</h2>
          <p className="text-xs text-indigo-200">Ask in plain words — I query the malaria database for you and show the numbers</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
          <span className="rounded-full bg-emerald-400/20 px-2.5 py-1 text-emerald-200">Free · no API key</span>
          <span className="rounded-full bg-sky-400/20 px-2.5 py-1 text-sky-200">Read-only</span>
          {status?.ready && <span className="rounded-full bg-white/10 px-2.5 py-1 text-indigo-100">Data {status.years} · latest {status.latest}</span>}
          {status && !status.ready && <span className="rounded-full bg-rose-400/20 px-2.5 py-1 text-rose-200">Database unavailable</span>}
          {messages.length > 0 && (
            <button type="button" onClick={reset} className="rounded-full border border-white/25 px-2.5 py-1 text-white hover:bg-white/10">New chat</button>
          )}
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (Math.abs(el.scrollTop - ownTop.current) < 2) return;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto p-4"
        aria-live="polite"
      >
        <div ref={contentRef} data-chat={messages.length > 0 ? "1" : "0"} className="space-y-5">
        {messages.length === 0 && (
          <div className="mx-auto max-w-4xl py-4">
            <div className="text-center">
              <p className="text-base font-semibold text-slate-800">What would you like to know?</p>
              <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-600">
                Cases, deaths, testing, species, age and sex · trends and seasons · rankings and filters · comparisons · “why did it change?” · unusual rises · forecasts · weather links.
                Follow-ups work (“and deaths?”, “what about Sylhet?”). I can read and analyse — I can never change the data.
              </p>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {STARTERS.map((group) => (
                <div key={group.title} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{group.title}</p>
                  <div className="space-y-1.5">
                    {group.prompts.map((p) => (
                      <button key={p} type="button" onClick={() => void ask(p)} className="block w-full rounded-lg border border-indigo-100 bg-white px-3 py-1.5 text-left text-xs text-indigo-900 hover:border-indigo-300 hover:bg-indigo-50">
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-sm text-white">
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex gap-3">
              <div aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 to-cyan-500 text-[11px] font-bold text-white">AI</div>
              <div className="min-w-0 max-w-[min(100%,56rem)] flex-1 rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-4 py-3 text-slate-800 shadow-sm">
                <AssistantBubble msg={m} onAsk={(q) => void ask(q)} isLast={m.id === lastBotId} busy={busy} />
              </div>
            </div>
          ),
        )}
        </div>
      </div>

      <div className="border-t border-slate-100 p-3">
        {ideas && messages.length > 0 && (
          <div className="mb-2 grid max-h-44 gap-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2 sm:grid-cols-2 lg:grid-cols-3">
            {STARTERS.map((g) => (
              <div key={g.title}>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{g.title}</p>
                {g.prompts.map((p) => (
                  <button key={p} type="button" onClick={() => void ask(p)} className="mt-1 block w-full truncate rounded border border-indigo-100 bg-white px-2 py-1 text-left text-xs text-indigo-900 hover:bg-indigo-50">{p}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          {messages.length > 0 && (
            <button type="button" onClick={() => setIdeas((v) => !v)} aria-expanded={ideas} className="h-10 shrink-0 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50">Ideas</button>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              } else if (e.key === "ArrowUp" && !input && lastUser) {
                e.preventDefault();
                setInput(lastUser);
              }
            }}
            rows={1}
            maxLength={600}
            placeholder="e.g. Which upazilas in Cox's Bazar had the most cases in 2025?"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            aria-label="Question"
          />
          <button type="submit" disabled={busy || !input.trim()} className="h-10 rounded-lg bg-indigo-600 px-5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? "Working…" : "Ask"}
          </button>
        </form>
        <p className="mt-1.5 text-[11px] text-slate-400">
          Read-only: I can analyse the data but never change it. Counts come straight from the NMEP MIS warehouse — check the SQL under “How I got this”.
        </p>
      </div>
    </div>
  );
}
