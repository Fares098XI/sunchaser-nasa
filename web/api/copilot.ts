/**
 * Ask Sunchaser: the serverless proxy between the browser and free AI models (setup: README).
 * POST /api/copilot {messages, state} -> {provider, model, text?, calls?, raw?} | {error}
 * Tries Google Gemini first, then Groq; each with a few models, moving on after a quota (429), server error, missing
 * model or timeout. The browser runs the tools (src/copilot/tools.ts) and loops; with every provider busy it answers
 * in offline mode (src/copilot/offline.ts). Keys only from the environment: GEMINI_API_KEY, GROQ_API_KEY.
 * Self-contained (no imports): Vercel runs this file as its own function.
 */

// ---------- the tools the model may call (run in the browser by src/copilot/tools.ts) and its rules ----------
export interface ToolParam { type: "string" | "number" | "integer" | "boolean" | "object" | "array"; description?: string; enum?: string[];
  properties?: Record<string, ToolParam>; required?: string[]; items?: ToolParam }
export interface ToolDef { name: string; description: string; parameters: ToolParam }

const LANDING: ToolParam = {
  type: "object", required: ["site_id", "landing_utc"], properties: {
    site_id: { type: "string", description: "a site id from list_sites" },
    landing_utc: { type: "string", description: "touchdown time, UTC, 'YYYY-MM-DDTHH:MM', between 2026-11-01 and 2028-12-31" },
    days: { type: "integer", description: "surface stay in days, 1-60 (default 14)" },
  },
};

export const TOOLS: ToolDef[] = [
  { name: "list_sites", description: "Every landing site Sunchaser can analyse: id, name, latitude/longitude, group (south-pole catalogue site with 20 m terrain, Apollo, commercial CLPS, other nations, or the user's own pin).",
    parameters: { type: "object", properties: {} } },
  { name: "compare_sites", description: "Rank sites over one period: sunlight %, longest darkness, Earth in view %, direct-to-Earth link %, longest blackout, solar energy, battery low point. Use for 'which site is best' and rankings over a period. For one or two specific landings, check_landing or explain_change say more.",
    parameters: { type: "object", required: ["start_date"], properties: {
      start_date: { type: "string", description: "start, 'YYYY-MM-DD' (12:00 UTC) or 'YYYY-MM-DDTHH:MM' UTC, 2026-11-01..2028-12-31" },
      days: { type: "integer", description: "length of the period in days (default 14)" },
      site_ids: { type: "array", items: { type: "string" }, description: "only these sites (default: all)" },
      sort_by: { type: "string", enum: ["sunlight", "link", "darkness", "blackout", "energy"], description: "ranking (default sunlight)" },
    } } },
  { name: "check_landing", description: "One landing checked against the mission requirements: GO or NO-GO and why, sunlight, link to Earth, longest night and blackout, battery, where in the lunar day it lands, and the first sunsets / link losses during the stay.",
    parameters: LANDING },
  { name: "find_windows", description: "Search every landing hour from Nov 2026 to Dec 2028 for landings that meet the requirements; returns the best windows (at one site, or the best site for each). Requirement values default to the app's current settings.",
    parameters: { type: "object", properties: {
      site_id: { type: "string", description: "only this site (default: every site)" },
      days: { type: "integer", description: "surface stay in days" },
      min_sunlight_pct: { type: "number" }, min_link_pct: { type: "number" }, max_blackout_h: { type: "number" },
      from_date: { type: "string", description: "earliest landing 'YYYY-MM-DD'" }, to_date: { type: "string", description: "latest landing 'YYYY-MM-DD'" },
      limit: { type: "integer", description: "how many windows (default 5)" },
    } } },
  { name: "explain_change", description: "Compare landing B with landing A and explain what changed and why; when both the site and the date differ, the change in sunlight and link is split exactly into a date part and a site part.",
    parameters: { type: "object", required: ["a", "b"], properties: { a: LANDING, b: LANDING } } },
  { name: "sky_at", description: "The Sun and Earth seen from a site at one time: elevation, compass direction, the terrain horizon in that direction, the share of each disc that is visible, and which Deep Space Network dishes can see the Moon.",
    parameters: { type: "object", required: ["site_id"], properties: {
      site_id: { type: "string" }, time_utc: { type: "string", description: "'YYYY-MM-DDTHH:MM' UTC (default: now)" } } } },
  { name: "search_knowledge", description: "How Sunchaser works and how far to trust it: methods, data sources, validation checks (V1-V12) and stated limits. Use for 'how', 'why', 'how accurate', 'what data'.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  { name: "show", description: "Offer the user a button that opens a view of Sunchaser on what you discussed. Set go_now only when the user asked to be taken there ('show me', 'take me', 'go to').",
    parameters: { type: "object", required: ["view", "label"], properties: {
      view: { type: "string", enum: ["globe", "explore", "compare", "windows", "replan", "scenarios", "stories", "learn", "validation"] },
      label: { type: "string", description: "button text, a few words" },
      site_id: { type: "string" }, landing_utc: { type: "string" }, days: { type: "integer" },
      lat: { type: "number", description: "for the globe: latitude, degrees north" }, lon: { type: "number", description: "longitude, degrees east (-180..360)" },
      scenarios: { type: "array", items: LANDING, description: "for the scenario board: up to 4 landings" },
      story: { type: "string", enum: ["im2", "apollo", "farside"] },
      go_now: { type: "boolean" },
    } } },
];

export const SYSTEM_PROMPT = `You are "Ask Sunchaser", the assistant inside Sunchaser, a NASA Space Apps 2026 web app that plans lunar landings by
sunlight (power) and the direct radio link to Earth, computed over the real terrain horizon from NASA data.

Rules:
- Every number you state must come from a tool result in this conversation. Never estimate, recall or invent numbers,
  dates or site facts. If no tool can answer, say so plainly.
- When the user gives a date without a time, use 12:00 UTC; always say the landing time (UTC) you used.
- Name a validation check (V1-V12) only when a search_knowledge result names it for that point.
- Call tools first, then answer. Use several tools when needed (e.g. list_sites to find an id, then check_landing).
- Site tables cover landings from 2026-11-01 to 2028-12-31. Outside that, say the data does not cover it.
- Answer in the user's language (English or Arabic). Be short and concrete: 2-6 sentences or a few bullets, numbers with
  units, the key answer first. Use **bold** for the answer and "- " bullets; no tables, no headings.
- When accuracy, method or data comes up, use search_knowledge and name the check or the limit it returns.
- Say how Sunchaser works or what it does not model only as search_knowledge or a tool result states it; add nothing else.
- Mention a limit only when the question is about accuracy or the limit changes the answer (for example coarser terrain at an
  atlas site); otherwise no limits note.
- Never write links, button text or separators ("—", "---") in the answer: the show tool makes the button.
- After answering, call show once with the most useful view (go_now only if the user asked to be taken there).
- "Link to Earth" means Earth above the local terrain and a DSN 70 m dish seeing the Moon above 6 degrees. Sunlight % is the average
  visible share of the solar disc. GO means the landing meets the requirements in the app's current settings (they are in the state).
- The user's current view of the app is in the state message: use it to resolve "here", "this site", "this date".`;


export interface CCall { id: string; name: string; args: Record<string, unknown> }
export interface CMsg {
  role: "user" | "assistant" | "tool";
  text?: string;
  calls?: CCall[];
  /** tool result: the call id and name it answers */
  id?: string; name?: string; result?: unknown;
  /** the provider's own content for an assistant turn, replayed unchanged to the same provider (Gemini thought signatures) */
  raw?: { provider: string; data: unknown };
}
interface Reply { provider: string; model: string; text?: string; calls?: CCall[]; raw?: { provider: string; data: unknown }; skipped?: string[] }

const LIMIT = { messages: 40, textChars: 4000, resultChars: 7000, bodyBytes: 250_000, perMinute: 30, perDay: 600 }; // requests; one question takes 2-4 (tool rounds)
const TIMEOUT_MS = 9_000, COOL_MS = 60_000;
/** model -> time it may be tried again, after a quota (429), overload (5xx) or timeout: later rounds skip it (per instance) */
const cool = new Map<string, number>();
/** a failed call's status; DAILY when the model's free quota for the day is used up (it then rests an hour) */
const DAILY = 4290;
async function failed(r: Response): Promise<number> {
  return r.status === 429 && /per.?day|daily/i.test(await r.text().catch(() => "")) ? DAILY : r.status;
}
const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

// ---------- Gemini (generativelanguage v1beta, function calling) ----------
const gType = (p: ToolParam): Record<string, unknown> => ({
  type: p.type.toUpperCase(), ...(p.description ? { description: p.description } : {}), ...(p.enum ? { enum: p.enum } : {}),
  ...(p.properties ? { properties: Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, gType(v)])) } : {}),
  ...(p.required ? { required: p.required } : {}), ...(p.items ? { items: gType(p.items) } : {}),
});
const G_TOOLS = [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description,
  ...(t.parameters.properties && Object.keys(t.parameters.properties).length ? { parameters: gType(t.parameters) } : {}) })) }];

function geminiBody(msgs: CMsg[], state: string) {
  const contents: { role: string; parts: unknown[] }[] = [];
  for (const m of msgs) {
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.text ?? "" }] });
    else if (m.role === "assistant") {
      if (m.raw?.provider === "gemini") { contents.push({ role: "model", parts: m.raw.data as unknown[] }); continue; }
      // a turn answered by another provider: rebuilt, with Gemini's documented placeholder signature for calls it did not make
      contents.push({ role: "model", parts: [...(m.text ? [{ text: m.text }] : []),
        ...(m.calls ?? []).map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args }, thoughtSignature: "skip_thought_signature_validator" }))] });
    } else {
      const part = { functionResponse: { id: m.id, name: m.name, response: { result: m.result } } }, last = contents[contents.length - 1];
      if (last?.role === "user" && (last.parts[0] as { functionResponse?: unknown })?.functionResponse) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }, { text: "App state now: " + state }] }, contents, tools: G_TOOLS,
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048, // short thinking keeps a tool round near 2 s; GEMINI_THINK=none for a model that rejects it
    ...(process.env.GEMINI_THINK === "none" ? {} : { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINK || "low" } }) } };
}

async function gemini(model: string, key: string, msgs: CMsg[], state: string, signal: AbortSignal): Promise<Reply | number> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(geminiBody(msgs, state)), signal });
  if (!r.ok) return failed(r);
  const j = await r.json(), parts: Record<string, unknown>[] = j?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("").trim();
  const calls = parts.filter((p) => p.functionCall).map((p, i) => {
    const f = p.functionCall as { id?: string; name: string; args?: Record<string, unknown> };
    return { id: f.id ?? `g${Date.now().toString(36)}${i}`, name: f.name, args: f.args ?? {} };
  });
  if (!text && !calls.length) return 502;
  return { provider: "gemini", model, text: text || undefined, calls: calls.length ? calls : undefined, raw: { provider: "gemini", data: parts } };
}

// ---------- Groq (OpenAI-compatible chat completions) ----------
const oType = (p: ToolParam): Record<string, unknown> => ({
  type: p.type, ...(p.description ? { description: p.description } : {}), ...(p.enum ? { enum: p.enum } : {}),
  ...(p.properties ? { properties: Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, oType(v)])) } : {}),
  ...(p.required ? { required: p.required } : {}), ...(p.items ? { items: oType(p.items) } : {}),
});
const O_TOOLS = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: oType(t.parameters) } }));

async function groq(model: string, key: string, msgs: CMsg[], state: string, signal: AbortSignal): Promise<Reply | number> {
  const messages: Record<string, unknown>[] = [{ role: "system", content: SYSTEM_PROMPT + "\n\nApp state now: " + state }];
  for (const m of msgs) {
    if (m.role === "user") messages.push({ role: "user", content: m.text ?? "" });
    else if (m.role === "assistant") messages.push({ role: "assistant", content: m.text ?? "",
      ...(m.calls?.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
    else messages.push({ role: "tool", tool_call_id: m.id, content: JSON.stringify(m.result) });
  }
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: O_TOOLS, tool_choice: "auto", temperature: 0.3, max_completion_tokens: 2048 }), signal });
  if (!r.ok) return failed(r);
  const msg = (await r.json())?.choices?.[0]?.message;
  const calls: CCall[] = (msg?.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* malformed arguments: run the tool with defaults */ }
    return { id: c.id, name: c.function.name, args };
  });
  const text = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (!text && !calls.length) return 502;
  return { provider: "groq", model, text: text || undefined, calls: calls.length ? calls : undefined };
}

// ---------- request handling ----------
const hits = new Map<string, { minute: number; m: number; day: number; d: number }>();
function allowed(ip: string) { // best effort: per running instance
  const now = Date.now(), minute = Math.floor(now / 60e3), day = Math.floor(now / 864e5);
  const h = hits.get(ip) ?? { minute, m: 0, day, d: 0 };
  if (h.minute !== minute) { h.minute = minute; h.m = 0; }
  if (h.day !== day) { h.day = day; h.d = 0; }
  h.m++; h.d++;
  hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.m <= LIMIT.perMinute && h.d <= LIMIT.perDay;
}

function clean(body: unknown): { msgs: CMsg[]; state: string } | null {
  const b = body as { messages?: unknown; state?: unknown };
  if (!Array.isArray(b?.messages) || !b.messages.length || b.messages.length > LIMIT.messages) return null;
  const msgs: CMsg[] = [];
  for (const x of b.messages as CMsg[]) {
    if (!x || !["user", "assistant", "tool"].includes(x.role)) return null;
    const text = typeof x.text === "string" ? x.text.slice(0, LIMIT.textChars) : undefined;
    let result = x.result;
    if (x.role === "tool") { const s = JSON.stringify(result ?? null); result = s.length > LIMIT.resultChars ? s.slice(0, LIMIT.resultChars) + "…(truncated)" : result; }
    msgs.push({ role: x.role, text, calls: Array.isArray(x.calls) ? x.calls.slice(0, 8) : undefined, id: x.id, name: x.name, result, raw: x.raw });
  }
  return { msgs, state: JSON.stringify(b.state ?? {}).slice(0, 4000) };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const ENV = () => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
/** an error message safe to return: any key text removed */
const scrub = (e: unknown) => {
  let m = e instanceof Error ? `${e.name}: ${e.message}${e.cause ? ` (${String((e.cause as Error).message ?? e.cause)})` : ""}` : String(e);
  for (const k of [ENV().GEMINI_API_KEY, ENV().GROQ_API_KEY]) if (k) m = m.split(k).join("***");
  return m.slice(0, 300);
};

/** every failure becomes a JSON answer the app can show (the browser then uses offline mode) */
export async function POST(request: Request): Promise<Response> {
  try { return await handle(request); } catch (e) { return json({ error: "server", detail: scrub(e) }, 500); }
}

async function handle(request: Request): Promise<Response> {
  // only this site may spend the quota
  const origin = request.headers.get("origin"), host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json({ error: "forbidden" }, 403);
  const ip = (request.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  if (!allowed(ip)) return json({ error: "rate" }, 429);
  const raw = await request.text();
  if (raw.length > LIMIT.bodyBytes) return json({ error: "too large" }, 413);
  let parsed: { msgs: CMsg[]; state: string } | null = null;
  try { parsed = clean(JSON.parse(raw)); } catch { /* invalid JSON */ }
  if (!parsed) return json({ error: "bad request" }, 400);

  const env = ENV();
  const chain: [string, (m: string, k: string, msgs: CMsg[], s: string, sig: AbortSignal) => Promise<Reply | number>, string | undefined, string[]][] = [
    ["gemini", gemini, env.GEMINI_API_KEY, list(env.GEMINI_MODEL, ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite"])],
    ["groq", groq, env.GROQ_API_KEY, list(env.GROQ_MODEL, ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"])],
  ];
  const tried: string[] = [];
  for (const [name, call, key, models] of chain) {
    if (!key) { tried.push(`${name}: no key`); continue; }
    for (const model of models) {
      if ((cool.get(model) ?? 0) > Date.now()) { tried.push(`${name}/${model}: resting`); continue; }
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const r = await call(model, key, parsed.msgs, parsed.state, ctl.signal);
        if (typeof r !== "number") return json(tried.length ? { ...r, skipped: tried } : r);
        tried.push(`${name}/${model}: ${r === DAILY ? "429 daily quota used" : r}`);
        if (r === 429 || r >= 500) cool.set(model, Date.now() + (r === DAILY ? 3600e3 : COOL_MS));
        if (r === 401 || r === 403) break; // a bad key: the other models of this provider will fail too
      } catch (e) {
        tried.push(`${name}/${model}: ${(e as Error).name === "AbortError" ? "timeout" : scrub(e)}`);
        cool.set(model, Date.now() + COOL_MS);
      } finally { clearTimeout(t); }
    }
  }
  return json({ error: "busy", tried }, 503);
}
