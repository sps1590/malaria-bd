"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MarkdownText } from "@/components/MarkdownText";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How has malaria changed in Bangladesh over the last 12 months?",
  "Which districts had the most cases in 2026?",
  "Forecast cases for Bandarban for the next months",
  "Does rainfall influence malaria cases in Rangamati?",
  "Any recent deaths or surge alerts?",
  "Show the monthly trend for Chattogram division in 2026",
];

export default function AnalystChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"claude" | "offline" | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/agent")
      .then((r) => r.json())
      .then((j: { mode: "claude" | "offline" }) => setMode(j.mode))
      .catch(() => setMode(null));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const replaceLast = (content: string) =>
    setMessages((m) => [...m.slice(0, -1), { role: "assistant", content }]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history: ChatMessage[] = [...messages.filter((m) => m.content.trim()), { role: "user", content: question }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-20) }),
      });
      if (!res.ok || !res.body) {
        replaceLast((await res.text()) || `Request failed (${res.status}).`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let answer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        replaceLast(answer);
      }
    } catch {
      replaceLast("Connection error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="flex h-[calc(100vh-15rem)] min-h-[520px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-slate-900 to-indigo-900 px-4 py-3 text-white">
        <div>
          <h2 className="text-sm font-semibold">Malaria AI Analyst</h2>
          <p className="text-xs text-indigo-200">Answers from the surveillance warehouse, ERA5 climate data, forecasts and alerts</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${mode === "claude" ? "bg-emerald-400/20 text-emerald-200" : "bg-amber-400/20 text-amber-200"}`}>
          {mode === "claude" ? "Claude Opus 5" : mode === "offline" ? "Offline mode" : "…"}
        </span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 && (
          <div className="mx-auto max-w-2xl py-6 text-center">
            <p className="text-sm text-slate-600">Ask anything about malaria in Bangladesh — cases, deaths, testing, species, age groups, hotspots, forecasts, weather links or alerts.</p>
            {mode === "offline" && (
              <p className="mt-2 text-xs text-amber-700">
                Running the built-in offline assistant. Add <code>ANTHROPIC_API_KEY</code> to enable the full Claude analyst for any free-form question.
              </p>
            )}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-800 hover:bg-indigo-100">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${m.role === "user" ? "bg-indigo-600 text-white" : "border border-slate-200 bg-slate-50 text-slate-800"}`}>
              {m.role === "user" ? (
                <p className="whitespace-pre-wrap text-sm">{m.content}</p>
              ) : m.content ? (
                <MarkdownText text={m.content} />
              ) : (
                <p className="animate-pulse text-sm text-slate-500">Analysing the data…</p>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} className="flex gap-2 border-t border-slate-100 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder="e.g. How many deaths were reported in Rangamati in 2025?"
          className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          aria-label="Question"
        />
        <button type="submit" disabled={busy || !input.trim()} className="rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
