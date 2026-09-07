import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "../..");
const WIDGET_URI = "ui://widget/ecg-catalog-v1.html";
const WIDGET_HTML = readFileSync(path.join(APP_ROOT, "public", "widget.html"), "utf8");
const MAX_RESULTS = 20;
const MAX_FILE_CHARS = 16_000;

const ALLOWED_ROOTS = ["agents", "commands", "contexts", "docs", "rules", "skills"];
const ALLOWED_FILES = new Set(["AGENTS.md", "CHATGPT.md", "COMMANDS-QUICK-REF.md", "RULES.md"]);

type CatalogItem = {
  id: string;
  title: string;
  kind: "skill" | "agent" | "command" | "context" | "rule" | "doc" | "guide";
  path: string;
};

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

function statSafe(filePath: string) {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

function walk(relativeDir: string): string[] {
  const absoluteDir = path.join(REPO_ROOT, relativeDir);
  if (!statSafe(absoluteDir)?.isDirectory()) return [];

  const output: string[] = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) output.push(...walk(relativePath));
    else output.push(relativePath);
  }
  return output;
}

function titleFromPath(relativePath: string): string {
  const base = path.basename(relativePath, path.extname(relativePath));
  return base.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function kindFromPath(relativePath: string): CatalogItem["kind"] {
  const root = relativePath.split(path.sep)[0];
  if (root === "skills") return "skill";
  if (root === "agents") return "agent";
  if (root === "commands") return "command";
  if (root === "contexts") return "context";
  if (root === "rules") return "rule";
  return "doc";
}

function buildCatalog(): CatalogItem[] {
  const paths = [
    ...ALLOWED_ROOTS.flatMap((root) => walk(root)),
    ...Array.from(ALLOWED_FILES),
  ].filter((relativePath) => relativePath.endsWith(".md"));

  return paths
    .map((relativePath) => ({
      id: relativePath.split(path.sep).join("/"),
      title: titleFromPath(relativePath),
      kind: ALLOWED_FILES.has(relativePath) ? "guide" : kindFromPath(relativePath),
      path: relativePath.split(path.sep).join("/"),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function readAllowedFile(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  const isAllowed = ALLOWED_FILES.has(normalized) || ALLOWED_ROOTS.some((root) => normalized.startsWith(`${root}/`));
  if (!isAllowed || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Requested path is outside the ECG public catalog.");
  }

  const absolutePath = path.resolve(REPO_ROOT, normalized);
  if (!absolutePath.startsWith(`${REPO_ROOT}${path.sep}`) || !statSafe(absolutePath)?.isFile()) {
    throw new Error("Catalog item was not found.");
  }
  return readFileSync(absolutePath, "utf8").slice(0, MAX_FILE_CHARS);
}

function snippetFor(relativePath: string, query: string): string {
  const text = readAllowedFile(relativePath);
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = index < 0 ? 0 : Math.max(0, index - 120);
  return text.slice(start, start + 360).replace(/\s+/g, " ").trim();
}

function appResource() {
  return {
    contents: [{
      uri: WIDGET_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: WIDGET_HTML,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "A compact browser for Everything ChatGPT skills, agents, commands, rules, contexts, and guides.",
      },
    }],
  };
}

function createAppServer(): McpServer {
  const server = new McpServer({ name: "everything-chatgpt", version: "0.2.0" });
  registerAppResource(server, "ecg-catalog-widget", WIDGET_URI, {}, async () => appResource());

  registerAppTool(server, "ecg_overview", {
    title: "Everything ChatGPT overview",
    description: "Use this when the user wants to understand ECG, its supported harnesses, or the available workflow catalog.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Loading ECG overview", "openai/toolInvocation/invoked": "ECG overview ready" },
  }, async (): Promise<ToolResult> => {
    const catalog = buildCatalog();
    return {
      content: [{ type: "text", text: "Everything ChatGPT catalog overview is ready." }],
      structuredContent: {
        view: "overview", headline: "Everything ChatGPT",
        message: "A ChatGPT- and Codex-first agent harness built from the Everything Claude Code foundation.",
        counts: {
          skills: catalog.filter((item) => item.kind === "skill").length,
          agents: catalog.filter((item) => item.kind === "agent").length,
          commands: catalog.filter((item) => item.kind === "command").length,
        },
      },
      _meta: { "openai/outputTemplate": WIDGET_URI },
    };
  });

  registerAppTool(server, "search", {
    title: "Search ECG catalog",
    description: "Use this when the user wants to find an ECG skill, agent, command, context, rule, or guide by topic or name.",
    inputSchema: { query: z.string().min(1).describe("Topic or name to search for.") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Searching ECG", "openai/toolInvocation/invoked": "ECG search complete" },
  }, async ({ query }): Promise<ToolResult> => {
    const normalizedQuery = query.trim().toLowerCase();
    const results = buildCatalog().map((item) => {
      const haystack = `${item.id} ${item.title} ${item.kind}`.toLowerCase();
      const nameMatch = haystack.includes(normalizedQuery);
      const contentMatch = nameMatch ? false : readAllowedFile(item.path).toLowerCase().includes(normalizedQuery);
      return { item, score: nameMatch ? 2 : contentMatch ? 1 : 0 };
    }).filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
      .slice(0, MAX_RESULTS)
      .map(({ item }) => ({ ...item, snippet: snippetFor(item.path, normalizedQuery) }));

    return {
      content: [{ type: "text", text: `Found ${results.length} ECG catalog item(s) for “${query.trim()}”.` }],
      structuredContent: { view: "search", headline: `ECG search: ${query.trim()}`, results },
      _meta: { "openai/outputTemplate": WIDGET_URI },
    };
  });

  registerAppTool(server, "fetch", {
    title: "Read an ECG catalog item",
    description: "Use this when the user wants the full contents of one ECG item returned by search, such as a skill or agent guide.",
    inputSchema: { id: z.string().min(1).describe("The catalog item id returned by search.") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Reading ECG item", "openai/toolInvocation/invoked": "ECG item ready" },
  }, async ({ id }): Promise<ToolResult> => {
    const content = readAllowedFile(id);
    return {
      content: [{ type: "text", text: `ECG catalog item: ${id}\n\n${content}` }],
      structuredContent: { view: "fetch", headline: titleFromPath(id), itemId: id, content },
      _meta: { "openai/outputTemplate": WIDGET_URI },
    };
  });

  return server;
}

const port = Number(process.env.PORT ?? "8787");
const MCP_PATH = "/mcp";

createServer(async (req, res) => {
  if (!req.url) { res.writeHead(400).end("Missing URL"); return; }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const isMcpRoute = url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`);

  if (req.method === "OPTIONS" && isMcpRoute) {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id", "Access-Control-Expose-Headers": "Mcp-Session-Id" }).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("Everything ChatGPT MCP server");
    return;
  }
  if (isMcpRoute && req.method && new Set(["GET", "POST", "DELETE"]).has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createAppServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch (error) { console.error("Failed to handle MCP request:", error); if (!res.headersSent) res.writeHead(500).end("Internal server error"); }
    return;
  }
  res.writeHead(404).end("Not Found");
}).listen(port, () => console.log(`Everything ChatGPT MCP server listening on http://localhost:${port}${MCP_PATH}`));
