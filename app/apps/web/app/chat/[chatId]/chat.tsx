"use client";
import { useChat } from "@ai-sdk/react";
import type { AppRouter, ChatMessage } from "@sllaw/api";
import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { DefaultChatTransport } from "ai";
import { useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { useTRPC } from "../../../trpc/client";

type View = NonNullable<inferRouterOutputs<AppRouter>["corpus"]["chunk"]>;
type Cite = { id: number; label: string };

// The main agent cites inline as [[chunkId|label]]. Each becomes a link Streamdown renders through `a` below, as a
// button with the agent's label; clicking it loads that chunk into the sidebar by id.
const CITE = /\[\[(\d+)(?:\|([^\]|]*))?\]\]/g;
const toLinks = (s: string) => s.replace(CITE, (_, id, label) => `[${(label || "source").trim()}](#cite-${id})`);

export function Chat({ id, initial }: { id: string; initial: ChatMessage[] }) {
  const { messages, sendMessage, status, error } = useChat<ChatMessage>({
    id,
    messages: initial,
    // only the new message goes up: the server holds the history
    transport: new DefaultChatTransport({ api: "/api/chat", prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, message: messages.at(-1) } }) }),
  });
  const [input, setInput] = useState("");
  const [open, setOpen] = useState<Cite | null>(null);
  const show = setOpen;
  // the open citation, fetched by chunk id (corpus.chunk); cached, so reopening one is instant
  const trpc = useTRPC();
  const view = useQuery(trpc.corpus.chunk.queryOptions({ chunkId: open?.id ?? 0 }, { enabled: !!open }));

  // ids the agent loaded (a citation of any other id is unverified) and every citation in its answers, in order
  const { loaded, cites } = useMemo(() => {
    const loaded = new Set<number>();
    const cites: Cite[] = [];
    for (const m of messages)
      for (const p of m.parts) {
        // what the agent read in full: a citation of anything else is unverified
        if (p.type === "tool-read" && p.state === "output-available") for (const c of p.output) loaded.add(c.chunkId);
        if (p.type === "tool-asOf" && p.state === "output-available" && p.output) {
          loaded.add(p.output.chunk.chunkId);
          for (const ch of p.output.changes) if (ch.byChunk != null) loaded.add(ch.byChunk); // its clause was shown
        }
        if (p.type === "text" && m.role === "assistant")
          for (const [, n, label] of p.text.matchAll(CITE)) if (!cites.some((c) => c.id === +n!)) cites.push({ id: +n!, label: label || "source" });
      }
    return { loaded, cites };
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    sendMessage({ text: input });
    setInput("");
  };

  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        const m = href?.match(/^#cite-(\d+)$/);
        if (!m) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        const n = +m[1]!;
        const ok = loaded.has(n);
        return (
          <button
            className={`cite${ok ? "" : " bad"}${open?.id === n ? " on" : ""}`}
            title={ok ? undefined : "cited but never loaded by the agent: unverified"}
            onClick={() => show({ id: n, label: String(children) })}
          >
            {children}
          </button>
        );
      },
    }),
    [loaded, open],
  );

  return (
    <div className="chat">
      <main className="thread">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((p, i) => {
              if (p.type === "text")
                return m.role === "assistant" ? (
                  <Streamdown key={i} className="md" components={components} isAnimating={busy && m.id === messages.at(-1)?.id}>
                    {toLinks(p.text)}
                  </Streamdown>
                ) : (
                  <div key={i} className="text">{p.text}</div>
                );
              if (p.type === "tool-search") return <div key={i} className="step">Searched: {p.input?.query}</div>;
              if (p.type === "tool-read") return <div key={i} className="step">Read {p.input?.chunkIds?.length ?? ""} provisions</div>;
              if (p.type === "tool-asOf") return <div key={i} className="step">Checked amendments</div>;
              if (p.type === "tool-links") return <div key={i} className="step">Followed links of {p.input?.docKey}</div>;
              return null;
            })}
          </div>
        ))}
        {status === "submitted" && <div className="step">Thinking…</div>}
        {error && <div className="error">Something went wrong: {error.message}</div>}
        <form onSubmit={send} className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send(e)}
            placeholder="Ask about Sri Lankan law…"
            rows={3}
          />
          <button disabled={busy || !input.trim()}>Send</button>
        </form>
      </main>
      <aside className="viewer">
        {open ? (
          <>
            <button className="link" onClick={() => setOpen(null)}>← Citations</button>
            <h3>{open.label}</h3>
            {view.isPending && <p className="muted">Loading…</p>}
            {view.isError && <p className="error">Could not load it: {view.error.message}</p>}
            {view.isSuccess && (view.data ? <Provision v={view.data} /> : <p className="error">This provision is no longer in the corpus.</p>)}
          </>
        ) : (
          <>
            <h3>Citations</h3>
            {!cites.length && <p className="muted">Provisions the answers cite show here.</p>}
            <ol>
              {cites.map((c) => (
                <li key={c.id}>
                  <button className="link" onClick={() => show(c)}>{c.label}</button>
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>
    </div>
  );
}

function Provision({ v }: { v: View }) {
  const { chunk: c, doc } = v;
  return (
    <div>
      <p>
        <strong>{doc?.title ?? c.docKey}</strong>
        <br />
        <span className="muted">{c.path ?? c.label}</span>
      </p>
      <div className="text">{c.text}</div>
      {v.changes.length > 0 && (
        <section>
          <h4>Changed by, up to {v.date}</h4>
          <ul>
            {v.changes.map((ch, i) => (
              <li key={i}>
                <a href={`/doc/${ch.by}${ch.byChunk ? `#c${ch.byChunk}` : ""}`} target="_blank">{ch.byTitle ?? ch.by}</a>
                {ch.byLabel ? `, s. ${ch.byLabel}` : ""}: {ch.kind}
                {ch.date ? ` (${ch.date})` : ""}
                <div className="muted">{ch.clause.slice(0, 240)}{ch.clause.length > 240 ? "…" : ""}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {v.later.length > 0 && (
        <p className="muted">Later: {v.later.map((l) => `${l.by} ${l.kind} (${l.date})`).join("; ")}</p>
      )}
      <p className="links">
        <a href={`/doc/${c.docKey}#c${c.chunkId}`} target="_blank">Open full document →</a>
        {doc?.sourceUrl && (
          <a href={doc.sourceUrl} target="_blank" rel="noreferrer">Source file ↗</a>
        )}
      </p>
    </div>
  );
}
