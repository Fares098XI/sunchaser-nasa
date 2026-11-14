/**
 * Ask Sunchaser's loop: send the conversation to /api/copilot, run the tools the model asks for on the engine,
 * send the results back, until the model answers (at most MAX_ROUNDS). Any failure (no internet, every free quota busy,
 * no keys) falls back to the offline router, so a question always gets an answer.
 */
import type { CCall, CMsg } from "../../api/copilot";
import { answerOffline } from "./offline";
import { sitesClient } from "../data/sitesClient";
import { runTool, STEP, type Action, type ToolCtx } from "./tools";

export interface Answer {
  text: string; actions: Action[]; provider: "gemini" | "groq" | "offline"; model?: string;
  /** why offline mode answered, and what each service said */
  reason?: string; detail?: string;
  /** numbers in the text, and those not found in any tool result of this turn */
  grounding: { checked: number; unmatched: string[] };
  tools: string[];
}

const MAX_ROUNDS = 6;
export const isArabic = (s: string) => /[؀-ۿ]/.test(s);

/** A short memory across turns: earlier questions and answers as plain text, tool traffic dropped. */
export class Conversation {
  history: CMsg[] = [];
  remember(q: string, a: Answer) {
    this.history.push({ role: "user", text: q }, { role: "assistant", text: a.text });
    this.history = this.history.slice(-12);
  }
}

export async function ask(conv: Conversation, question: string, ctx: ToolCtx, state: Record<string, unknown>,
  onStep: (line: string) => void, endpoint = "/api/copilot"): Promise<Answer> {
  const ar = isArabic(question), msgs: CMsg[] = [...conv.history, { role: "user", text: question }];
  // the site ids up front save the model a list_sites round
  const c = sitesClient(); await c.ready.catch(() => undefined);
  state = { ...state, sites: c.manifest?.sites.map((s) => `${s.id}=${s.name}`).join("; ") };
  const results: unknown[] = [], actions: Action[] = [], tools: string[] = [];
  let reason = "", detail = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let reply: { provider: "gemini" | "groq"; model: string; text?: string; calls?: CCall[]; raw?: CMsg["raw"]; error?: string; tried?: string[]; detail?: string };
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: msgs, state }) });
      reply = await r.json();
      if (!r.ok) { detail = reply.tried?.join("; ") ?? reply.detail ?? ""; reason = r.status === 429 ? "too many questions this minute" : r.status === 503 ? "the free AI services are busy or not set up" : `server ${r.status}`; break; }
    } catch {
      reason = navigator.onLine === false ? "no internet connection" : "the AI service could not be reached";
      break;
    }
    if (!reply.calls?.length) {
      const text = cleanText(reply.text ?? "");
      if (!text) { reason = "empty answer"; break; }
      return { text, actions: dedupe(actions), provider: reply.provider, model: reply.model, grounding: ground(text, [question, state, ...results]), tools };
    }
    msgs.push({ role: "assistant", text: reply.text, calls: reply.calls, raw: reply.raw });
    for (const c of reply.calls) {
      onStep(STEP[c.name]?.[ar ? 1 : 0] ?? c.name);
      tools.push(c.name);
      const { result, action } = await runTool(c.name, c.args, ctx);
      if (action) actions.push(action);
      results.push(result);
      msgs.push({ role: "tool", id: c.id, name: c.name, result });
    }
    if (round === MAX_ROUNDS - 1) reason = "the question needed too many steps";
  }
  onStep(ar ? "الوضع دون اتصال" : "Answering in offline mode");
  const off = await answerOffline(question, ctx, state);
  return { ...off, actions: dedupe([...actions, ...off.actions]), provider: "offline", reason, detail, grounding: ground(off.text, [question, state, ...off.results]), tools: off.tools };
}

/** Models sometimes paste a tool's action object (or a code block) into the answer; the action is shown as a button anyway. */
export const cleanText = (s: string) =>
  s.replace(/```(?:json)?[\s\S]*?```/g, "").replace(/\{[^{}]*"(?:view|site_id|landing_utc|label)"\s*:[^{}]*\}/g, "").replace(/\n{3,}/g, "\n\n").trim();

const dedupe = (a: Action[]) => a.filter((x, i) => a.findIndex((y) => y.view === x.view && y.label === x.label) === i).slice(0, 3);

// ---------- grounding: every number in the answer should be in a tool result (or the question / app state) ----------
const DIGITS: Record<string, string> = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "٫": ".", "٬": "" };
const western = (s: string) => s.replace(/[٠-٩٫٬]/g, (c) => DIGITS[c]);
const nums = (s: string) => [...western(s).replace(/(\d),(\d{3})/g, "$1$2").matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => m[0]);

/**
 * A number in the text is grounded when some source number rounds to it at the text's precision (also as hours ↔ days,
 * % ↔ fraction, Wh ↔ kWh). Small counts (≤ 12) and parts of dates and times are not checked.
 */
export function ground(text: string, sources: unknown[]): { checked: number; unmatched: string[] } {
  const src = nums(sources.map((s) => (typeof s === "string" ? s : JSON.stringify(s))).join(" ")).map(Number);
  const pool = new Set<number>();
  for (const v of src) for (const x of [v, v / 24, v * 24, v * 100, v / 1000, v * 1000, Math.abs(v)]) pool.add(x);
  const plain = western(text).replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ").replace(/\bV\d+[a-d]?\b/gi, " ");
  const unmatched: string[] = [];
  let checked = 0;
  for (const t of nums(plain)) {
    const v = Math.abs(Number(t));
    if (Number.isInteger(v) && v <= 12 && !t.includes(".")) continue;
    checked++;
    const dp = t.includes(".") ? t.split(".")[1].length : 0, tol = 0.5 * 10 ** -dp + 1e-9;
    let ok = false;
    for (const x of pool) if (Math.abs(Math.abs(x) - v) <= tol) { ok = true; break; }
    if (!ok) unmatched.push(t);
  }
  return { checked, unmatched };
}
