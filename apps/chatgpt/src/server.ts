import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { planWorkflow } from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "../..");
const WIDGET_URI = "ui://widget/ecg-catalog-v1.html";
const WIDGET_HTML = readFileSync(path.join(APP_ROOT, "public", "widget.html"), "utf8");
const VERSION = "0.6.0";
const MAX_RESULTS = 20;
const MAX_FILE_CHARS = 16_000;
const MAX_REQUEST_BYTES = 1_000_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const ALLOWED_ROOTS = ["agents", "commands", "contexts", "docs", "rules", "skills"];
const ALLOWED_FILES = new Set(["AGENTS.md", "CHATGPT.md", "COMMANDS-QUICK-REF.md", "RULES.md"]);
const ALLOWED_ORIGINS = new Set((process.env.ECG_ALLOWED_ORIGINS ?? "https://chatgpt.com,https://www.chatgpt.com,https://chat.openai.com,http://localhost:3000,http://localhost:8787").split(",").map((item) => item.trim()).filter(Boolean));
const ACCESS_TOKEN = process.env.ECG_ACCESS_TOKEN?.trim();
const rateLimits = new Map<string, { count: number; resetAt: number }>();

type CatalogItem = { id: string; title: string; kind: "skill" | "agent" | "command" | "context" | "rule" | "doc" | "guide"; path: string };
type ToolResult = { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown>; _meta?: Record<string, unknown> };

function statSafe(filePath: string) { try { return statSync(filePath); } catch { return undefined; } }
function walk(relativeDir: string): string[] {
  const absoluteDir = path.join(REPO_ROOT, relativeDir);
  if (!statSafe(absoluteDir)?.isDirectory()) return [];
  const output: string[] = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) output.push(...walk(relativePath)); else output.push(relativePath);
  }
  return output;
}
function titleFromPath(relativePath: string): string { return path.basename(relativePath, path.extname(relativePath)).replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function kindFromPath(relativePath: string): CatalogItem["kind"] {
  const root = relativePath.split(path.sep)[0];
  if (root === "skills") return "skill"; if (root === "agents") return "agent"; if (root === "commands") return "command"; if (root === "contexts") return "context"; if (root === "rules") return "rule"; return "doc";
}
function buildCatalog(): CatalogItem[] {
  return [...ALLOWED_ROOTS.flatMap(walk), ...ALLOWED_FILES].filter((item) => item.endsWith(".md")).map((relativePath) => ({ id: relativePath.split(path.sep).join("/"), title: titleFromPath(relativePath), kind: ALLOWED_FILES.has(relativePath) ? "guide" : kindFromPath(relativePath), path: relativePath.split(path.sep).join("/") })).sort((left, right) => left.id.localeCompare(right.id));
}
function readAllowedFile(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  const allowed = ALLOWED_FILES.has(normalized) || ALLOWED_ROOTS.some((root) => normalized.startsWith(`${root}/`));
  if (!allowed || !normalized.endsWith(".md") || normalized.startsWith("../") || normalized.includes("/../")) throw new Error("Requested path is outside the ECG public catalog.");
  const absolutePath = path.resolve(REPO_ROOT, normalized);
  if (!absolutePath.startsWith(`${REPO_ROOT}${path.sep}`) || !statSafe(absolutePath)?.isFile()) throw new Error("Catalog item was not found.");
  return readFileSync(absolutePath, "utf8").slice(0, MAX_FILE_CHARS);
}
function snippetFor(relativePath: string, query: string): string {
  const text = readAllowedFile(relativePath); const index = text.toLowerCase().indexOf(query.toLowerCase()); const start = index < 0 ? 0 : Math.max(0, index - 120); return text.slice(start, start + 360).replace(/\s+/g, " ").trim();
}
function appResource() { return { contents: [{ uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: WIDGET_HTML, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/widgetDescription": "A compact browser for Everything ChatGPT skills, agents, commands, rules, contexts, and guides." } }] }; }

function createAppServer(): McpServer {
  const server = new McpServer({ name: "everything-chatgpt", version: VERSION }, { instructions: "ECG is a skills and workflow library. Use search and fetch to find the relevant guide, then follow it. Use the native GitHub app/connector and Codex for repository reads, edits, tests, branches, pull requests, and review fixes. Create ready-for-review pull requests, but never merge without explicit user approval." });
  registerAppResource(server, "ecg-catalog-widget", WIDGET_URI, {}, async () => appResource());
  const meta = { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI };
  registerAppTool(server, "ecg_overview", { title: "Everything ChatGPT overview", description: "Use this when the user wants to understand ECG or its available skills and workflow catalog.", inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: meta }, async (): Promise<ToolResult> => {
    const catalog = buildCatalog(); return { content: [{ type: "text", text: "Everything ChatGPT skills catalog is ready." }], structuredContent: { view: "overview", headline: "Everything ChatGPT", message: "A ChatGPT- and Codex-first skills and workflow library built from the Everything Claude Code foundation. GitHub actions are handled by the native GitHub app and Codex.", counts: { skills: catalog.filter((item) => item.kind === "skill").length, agents: catalog.filter((item) => item.kind === "agent").length, commands: catalog.filter((item) => item.kind === "command").length } }, _meta: meta };
  });
  registerAppTool(server, "search", { title: "Search ECG catalog", description: "Use this when the user wants to find an ECG skill, agent, command, context, rule, or guide by topic or name.", inputSchema: { query: z.string().min(1).max(256).describe("Topic or name to search for.") }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: meta }, async ({ query }): Promise<ToolResult> => {
    const normalized = query.trim().toLowerCase(); const results = buildCatalog().map((item) => { const haystack = `${item.id} ${item.title} ${item.kind}`.toLowerCase(); const nameMatch = haystack.includes(normalized); const contentMatch = nameMatch ? false : readAllowedFile(item.path).toLowerCase().includes(normalized); return { item, score: nameMatch ? 2 : contentMatch ? 1 : 0 }; }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, MAX_RESULTS).map(({ item }) => ({ ...item, snippet: snippetFor(item.path, normalized) }));
    return { content: [{ type: "text", text: `Found ${results.length} ECG catalog item(s) for “${query.trim()}”.` }], structuredContent: { view: "search", headline: `ECG search: ${query.trim()}`, results }, _meta: meta };
  });
  registerAppTool(server, "fetch", { title: "Read an ECG catalog item", description: "Use this when the user wants the full contents of one ECG item returned by search.", inputSchema: { id: z.string().min(1).max(512).describe("The catalog item id returned by search.") }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: meta }, async ({ id }): Promise<ToolResult> => {
    const content = readAllowedFile(id); return { content: [{ type: "text", text: `ECG catalog item: ${id}\n\n${content}` }], structuredContent: { view: "fetch", headline: titleFromPath(id), itemId: id, content }, _meta: meta };
  });
  registerAppTool(server, "ecg_plan_workflow", { title: "Plan a coding workflow", description: "Use this when the user wants ECG to recommend a sequence of skills for a coding, testing, review, or security task. This tool plans; native Codex and GitHub tools perform the work.", inputSchema: { goal: z.string().min(1).max(2_000), language: z.string().max(100).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: meta }, async ({ goal, language }): Promise<ToolResult> => {
    const catalogIds = new Set(buildCatalog().map((item) => item.id)); const plan = planWorkflow(goal, language); const steps = plan.steps.map((step) => ({ ...step, skillIds: step.skillIds.filter((skillId) => catalogIds.has(skillId)) }));
    return { content: [{ type: "text", text: `${plan.headline}: ${steps.length} ordered steps.` }], structuredContent: { view: "workflow", headline: plan.headline, steps, notes: [...plan.notes, "GitHub reads, writes, tests, pull requests, and review handling are delegated to the native GitHub app and Codex."] }, _meta: meta };
  });
  return server;
}

function requestId(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString().slice(0, 100) || crypto.randomUUID(); }
function logEvent(event: string, fields: Record<string, unknown> = {}) { console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields })); }
function sendJson(res: ServerResponse, status: number, payload: unknown) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(payload)); }
function allowedOrigin(req: IncomingMessage): string | undefined { const origin = req.headers.origin; return origin && ALLOWED_ORIGINS.has(origin) ? origin : undefined; }
function rateLimited(req: IncomingMessage): boolean { const key = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.socket.remoteAddress || "unknown"; const now = Date.now(); const current = rateLimits.get(key); if (!current || current.resetAt <= now) { rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS }); return false; } current.count += 1; return current.count > RATE_LIMIT_MAX_REQUESTS; }
function authorized(req: IncomingMessage): boolean { return !ACCESS_TOKEN || req.headers.authorization === `Bearer ${ACCESS_TOKEN}`; }

const port = Number(process.env.PORT ?? "8787");
createServer(async (req, res) => {
  const startedAt = Date.now(); const id = requestId(req); const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`); const isMcp = url.pathname === "/mcp";
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Request-Id", id); const origin = allowedOrigin(req); if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  logEvent("request.started", { id, method: req.method, path: url.pathname }); res.on("finish", () => logEvent("request.finished", { id, status: res.statusCode, durationMs: Date.now() - startedAt }));
  if (isMcp && req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization, x-request-id" }).end(); return; }
  if (isMcp && rateLimited(req)) { res.writeHead(429, { "retry-after": "60" }).end("Rate limit exceeded"); return; }
  if (isMcp && !authorized(req)) { res.writeHead(401, { "www-authenticate": "Bearer" }).end("Authentication required"); return; }
  if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) { res.writeHead(413).end("Request too large"); return; }
  if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Everything ChatGPT skills catalog MCP server"); return; }
  if (req.method === "GET" && url.pathname === "/healthz") { sendJson(res, 200, { status: "ok", service: "everything-chatgpt", version: VERSION, surface: "skills-first" }); return; }
  if (isMcp && ["GET", "POST", "DELETE"].includes(req.method ?? "")) { const server = createAppServer(); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); res.on("close", () => { void transport.close(); void server.close(); }); try { await server.connect(transport); await transport.handleRequest(req, res); } catch (error) { logEvent("request.error", { id, error: error instanceof Error ? error.message : String(error) }); if (!res.headersSent) res.writeHead(500).end("Internal server error"); } return; }
  res.writeHead(404).end("Not Found");
}).listen(port, () => logEvent("server.started", { port, version: VERSION, surface: "skills-first" }));
