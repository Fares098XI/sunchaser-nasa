import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ask, Conversation, isArabic, type Answer } from "./agent";
import type { Action, ToolCtx } from "./tools";

/**
 * Ask Sunchaser: a chat panel over every view. Answers come from free AI models that call Sunchaser's own engine
 * (copilot/tools.ts), or from offline mode; each answer says who answered and whether its numbers trace to the engine.
 */
interface Props {
  ctx: ToolCtx;
  /** what the user is looking at, sent with each question */
  state: Record<string, unknown>;
  mode: string;
  onAction: (a: Action) => void;
}
interface Item { q: string; steps: string[]; a?: Answer; error?: string }

const SUGGEST: Record<string, string[]> = {
  home: ["Which south-pole site gets the most sunlight in January 2027?", "When should I land at Shackleton Rim for 14 days?", "How accurate is Sunchaser?", "ما أفضل موقع للهبوط في مارس 2027؟"],
  explore: ["Where is the Sun right now here?", "When should I land here for 14 days?", "Why does this site keep its light?", "متى يكون أفضل هبوط هنا؟"],
  compare: ["Which site has the best link to Earth this period?", "Compare Connecting Ridge and Shackleton Rim", "Why do the Apollo sites lose the Sun?"],
  windows: ["Find the best 2027 landing with at least 80 % sunlight", "What is the smallest change that opens a window?", "How are windows ranked?"],
  replan: ["My landing at Nobile Rim 1 on 2027-01-09 slips two weeks: what changes?", "Which site is best if we land in February 2027?"],
  scenarios: ["Explain the difference between scenario A and B", "Is scenario A a GO?", "How is the change split into date and site?"],
  stories: ["Check a landing at Apollo 15 on 2027-03-15", "Why can't Chang'e 4 talk to Earth directly?", "Take me to Apollo 11 on the globe"],
  learn: ["Why does the south pole have days-long light?", "What does 'link to Earth' mean here?", "How is sunlight measured?"],
  validation: ["Which checks failed and why?", "What is V2?", "What does Sunchaser not model?"],
};
const SR: (new () => any) | undefined = typeof window !== "undefined" ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** **bold** and "- " bullets only; the model's text is never injected as HTML. */
function Rich({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : <Fragment key={i}>{p.replace(/\*/g, "")}</Fragment>));
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; };
  for (const line of text.split("\n").filter((l) => !/^\s*(?:[—–-]{1,3}|\[[^\]]*\]|\*{3})\s*$/.test(l))) { // separators, "[Show …]" stubs
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (m) list.push(m[1]);
    else { flush(); if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ""))}</p>); }
  }
  flush();
  return <>{blocks}</>;
}

/** reveal an answer over ~0.7 s */
function Typed({ text }: { text: string }) {
  const [n, setN] = useState(() => (reduced() ? text.length : 0));
  useEffect(() => {
    if (n >= text.length) return;
    const id = requestAnimationFrame(() => setN((v) => Math.min(text.length, v + Math.max(3, Math.ceil(text.length / 45)))));
    return () => cancelAnimationFrame(id);
  }, [n, text]);
  return <Rich text={text.slice(0, n)} />;
}

const PROVIDER: Record<Answer["provider"], string> = { gemini: "Google Gemini", groq: "Groq", offline: "Offline mode" };

export function CopilotPanel({ ctx, state, mode, onAction }: Props) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("ask"));
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceAr, setVoiceAr] = useState(false);
  const conv = useRef(new Conversation());
  const live = useRef({ ctx, state });
  live.current = { ctx, state };
  const scroller = useRef<HTMLDivElement>(null), rec = useRef<any>(null);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduced() ? "auto" : "smooth" }); }, [items]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(false);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((v) => !v); }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open]);

  const send = async (q: string) => {
    q = q.trim().slice(0, 600);
    if (!q || busy) return;
    setText(""); setBusy(true); setOpen(true);
    setItems((v) => [...v, { q, steps: [] }]);
    const patch = (p: Partial<Item>) => setItems((v) => v.map((it, i) => (i === v.length - 1 ? { ...it, ...p } : it)));
    try {
      const a = await ask(conv.current, q, live.current.ctx, live.current.state,
        (line) => setItems((v) => v.map((it, i) => (i === v.length - 1 ? { ...it, steps: [...it.steps, line] } : it))));
      conv.current.remember(q, a);
      patch({ a });
      const go = a.actions.find((x) => x.go_now);
      if (go) setTimeout(() => onAction(go), 900);
    } catch (e) {
      patch({ error: String(e) });
    }
    setBusy(false);
  };

  // the eval harness (scripts) asks through the same loop as the panel
  useEffect(() => {
    const one = (q: string, endpoint?: string) => ask(new Conversation(), q, live.current.ctx, live.current.state, () => undefined, endpoint);
    (window as any).__sunchaserCopilot = {
      ask: one,
      /** V13: the question set through the AI (or offline: endpoint "/api/none"); results also on window.__copilotEval */
      eval: async (endpoint?: string, gapS = 0) => {
        const { EVAL } = await import("./evalset"), out: unknown[] = ((window as any).__copilotEval = []);
        for (const e of EVAL) {
          if (out.length) await new Promise((r) => setTimeout(r, gapS * 1000)); // free tiers limit tokens per minute
          const t = performance.now(), a = await one(e.q, endpoint);
          out.push({ q: e.q, want: e.tool, used: a.tools, toolOk: !e.tool || a.tools.includes(e.tool), provider: a.provider, model: a.model ?? a.reason,
            s: +((performance.now() - t) / 1000).toFixed(1), numbers: a.grounding.checked, unmatched: a.grounding.unmatched, actions: a.actions.map((x) => x.view), text: a.text });
        }
        return out;
      },
    };
  }, []);

  const listen = () => {
    if (!SR) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new SR();
    r.lang = voiceAr ? "ar-EG" : "en-US"; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e: any) => {
      const t = Array.from(e.results as ArrayLike<any>).map((x: any) => x[0].transcript).join("");
      setText(t);
      if (e.results[e.results.length - 1].isFinal) { r.stop(); send(t); }
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r; r.start(); setListening(true);
  };
  const speak = (t: string) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t.replace(/\*\*/g, "").replace(/^- /gm, ""));
    u.lang = isArabic(t) ? "ar-EG" : "en-US";
    speechSynthesis.speak(u);
  };

  const sugg = SUGGEST[mode] ?? SUGGEST.home;
  return (
    <>
      <button className={`ask-fab ${open ? "hide" : ""}`} onClick={() => setOpen(true)} aria-label="Ask Sunchaser (Ctrl+K)" title="Ask Sunchaser (Ctrl+K)">
        <span className="ask-spark" aria-hidden>✦</span><span className="ask-fab-label"> Ask Sunchaser</span>
      </button>
      {open && (
        <aside className="ask glass" aria-label="Ask Sunchaser">
          <header className="ask-head">
            <div><b>Ask Sunchaser</b><span className="dim"> · answers from the real engine</span></div>
            <div className="ask-head-btns">
              {items.length > 0 && <button className="link" onClick={() => { setItems([]); conv.current = new Conversation(); }} title="New conversation">New</button>}
              <button className="ask-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
          </header>

          <div className="ask-log" ref={scroller} aria-live="polite">
            {!items.length && (
              <div className="ask-hello">
                <p>Ask about landing sites, dates, sunlight, the link to Earth, or how Sunchaser works, in English or Arabic.
                  Every number comes from Sunchaser's own calculations, and I can open the view that shows it.</p>
              </div>
            )}
            {items.map((it, i) => (
              <div key={i} className="ask-turn">
                <div className="ask-q" dir="auto">{it.q}</div>
                {!it.a && !it.error && (
                  <div className="ask-steps">
                    {it.steps.length ? it.steps.map((s, k) => <div key={k} className={k === it.steps.length - 1 ? "now" : "done"}>{k === it.steps.length - 1 ? "◌" : "✓"} {s}</div>)
                      : <div className="now">◌ Thinking</div>}
                  </div>
                )}
                {it.error && <div className="ask-a error">Something went wrong: {it.error}</div>}
                {it.a && (
                  <div className="ask-a" dir="auto">
                    {i === items.length - 1 ? <Typed text={it.a.text} /> : <Rich text={it.a.text} />}
                    {it.a.actions.length > 0 && (
                      <div className="ask-actions">
                        {it.a.actions.map((x, k) => <button key={k} className="ask-go" onClick={() => onAction(x)}>{x.label} →</button>)}
                      </div>
                    )}
                    <div className="ask-meta">
                      <span className={`ask-badge ${it.a.provider}`} title={it.a.reason ? `Offline because ${it.a.reason}${it.a.detail ? ` (${it.a.detail})` : ""}` : it.a.model}>{PROVIDER[it.a.provider]}</span>
                      {it.a.grounding.checked > 0 && (it.a.grounding.unmatched.length
                        ? <span className="ask-warn" title="Not found in the results of Sunchaser's tools for this question: check it in the view">⚠ not traced: {it.a.grounding.unmatched.slice(0, 3).join(", ")}</span>
                        : <span className="ask-ok" title="Every number in this answer matches a result of Sunchaser's engine">✓ {it.a.grounding.checked} number{it.a.grounding.checked > 1 ? "s" : ""} traced to the engine</span>)}
                      {"speechSynthesis" in window && <button className="link" onClick={() => speak(it.a!.text)} aria-label="Read the answer aloud">🔊</button>}
                    </div>
                    {it.a.provider === "offline" && it.a.reason && <div className="dim ask-why">Offline because {it.a.reason}.</div>}
                  </div>
                )}
              </div>
            ))}
          </div>

          {!busy && (
            <div className="ask-sugg" role="group" aria-label="Suggested questions">
              {sugg.slice(0, items.length ? 2 : 4).map((s) => <button key={s} className="chip-btn" dir="auto" onClick={() => send(s)}>{s}</button>)}
            </div>
          )}

          <form className="ask-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <textarea autoFocus value={text} dir="auto" rows={1} maxLength={600} placeholder={listening ? (voiceAr ? "أستمع…" : "Listening…") : "Ask anything… / اسأل بالعربية"}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} aria-label="Your question" />
            {SR && <>
              <button type="button" className="ask-lang" onClick={() => setVoiceAr((v) => !v)} title="Voice language" aria-label={`Voice language: ${voiceAr ? "Arabic" : "English"}`}>{voiceAr ? "ع" : "EN"}</button>
              <button type="button" className={`ask-mic ${listening ? "on" : ""}`} onClick={listen} aria-label={listening ? "Stop listening" : "Ask by voice"} title="Ask by voice">🎙</button>
            </>}
            <button className="ask-send" disabled={busy || !text.trim()} aria-label="Send">↑</button>
          </form>
          <p className="ask-note dim">AI-assisted (free Google Gemini / Groq models, or offline rules). It can misread a question: the numbers come from Sunchaser's engine, check them in the view.</p>
        </aside>
      )}
    </>
  );
}
