import { defineConfig, loadEnv, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { GET } from "./api/dem";
import { POST } from "./api/copilot";

// the serverless functions (api/*.ts) on the dev and preview servers too
const toRequest = async (req: Connect.IncomingMessage) => {
  const url = "http://" + (req.headers.host ?? "localhost") + ((req as { originalUrl?: string }).originalUrl ?? req.url);
  const chunks: Buffer[] = [];
  if (req.method === "POST") for await (const c of req) chunks.push(c as Buffer);
  return new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined });
};
const mount = (handler: (r: Request) => Promise<Response>): Connect.NextHandleFunction => async (req, res) => {
  const r = await handler(await toRequest(req));
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await r.arrayBuffer()));
};
const api = (s: { middlewares: Connect.Server }) => {
  s.middlewares.use("/api/dem", mount(GET));
  s.middlewares.use("/api/copilot", mount(POST));
};

export default defineConfig(({ mode }) => {
  // the AI keys for local testing (web/.env.local, ignored by Git) reach the copilot function, never the browser bundle
  Object.assign(process.env, loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), ["GEMINI_", "GROQ_"]));
  return { plugins: [react(), { name: "api", configureServer: api, configurePreviewServer: api }] };
});
