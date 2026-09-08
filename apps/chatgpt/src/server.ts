import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
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
const MAX_GITHUB_RESULTS = 10;
const MAX_GITHUB_TREE_ENTRIES = 200;
const MAX_GITHUB_QUERY_CHARS = 256;
const MAX_GITHUB_PATH_CHARS = 512;
const MAX_REQUEST_BYTES = 1_000_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const MCP_METHODS = new Set(["GET", "POST", "DELETE"]);
const ACCESS_TOKEN = process.env.ECG_ACCESS_TOKEN?.trim();
const AUTH_MODE = process.env.ECG_AUTH_MODE?.trim().toLowerCase() ?? "anonymous";
const OAUTH_ENABLED = AUTH_MODE === "oauth";
const PUBLIC_RESOURCE_URL = (process.env.ECG_RESOURCE_URL?.trim() || "https://everything-chatgpt.onrender.com").replace(/\/$/, "");
const OAUTH_ISSUER = (process.env.ECG_OAUTH_ISSUER?.trim() || PUBLIC_RESOURCE_URL).replace(/\/$/, "");
const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? "";
const GITHUB_CALLBACK_URL = process.env.GITHUB_OAUTH_CALLBACK_URL?.trim() || `${PUBLIC_RESOURCE_URL}/oauth/github/callback`;
const OAUTH_SCOPES = ["ecg:read"] as const;
const OAUTH_CODE_TTL_MS = 5 * 60_000;
const OAUTH_TOKEN_TTL_MS = 60 * 60_000;
const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const oauthStates = new Map<string, OAuthState>();
const oauthCodes = new Map<string, OAuthCode>();
const oauthAccessTokens = new Map<string, OAuthToken>();
const oauthRefreshTokens = new Map<string, OAuthRefreshToken>();
const ALLOWED_ORIGINS = new Set(
  (process.env.ECG_ALLOWED_ORIGINS ?? "https://chatgpt.com,https://www.chatgpt.com,https://chat.openai.com,http://localhost:3000,http://localhost:8787")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const rateLimits = new Map<string, { count: number; resetAt: number }>();

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

type GitHubIdentity = { id: number; login: string; name?: string | null; email?: string | null; githubAccessToken?: string };
type OAuthState = {
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  state?: string;
  createdAt: number;
};
type OAuthCode = OAuthState & { identity: GitHubIdentity; used: boolean };
type OAuthToken = { identity: GitHubIdentity; scope: string; resource: string; expiresAt: number };
type OAuthRefreshToken = { identity: GitHubIdentity; scope: string; resource: string; expiresAt: number };

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
  if (!isAllowed || !normalized.endsWith(".md") || normalized.startsWith("../") || normalized.includes("/../")) {
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

function githubPathSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid GitHub ${label}.`);
  }
  return normalized;
}

function githubRepository(owner: string, repo: string): { owner: string; repo: string } {
  return { owner: githubPathSegment(owner, "owner"), repo: githubPathSegment(repo.replace(/\.git$/, ""), "repository") };
}

function githubFilePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.length > MAX_GITHUB_PATH_CHARS || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid GitHub file path.");
  }
  return normalized;
}

function githubRef(value: string | undefined): string {
  const ref = (value ?? "").trim();
  if (ref.length > 256 || ref.includes("..") || /[\r\n]/.test(ref)) throw new Error("Invalid GitHub ref.");
  return ref;
}

async function githubApi<T>(apiPath: string, identity?: GitHubIdentity): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "everything-chatgpt/0.3.0",
  };
  if (identity?.githubAccessToken) headers.authorization = `Bearer ${identity.githubAccessToken}`;
  const response = await fetch(`https://api.github.com${apiPath}`, { headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) throw new Error("GitHub authorization does not allow this repository or the GitHub rate limit was reached.");
    if (response.status === 404) throw new Error("GitHub repository or resource was not found, or it is not accessible to this account.");
    throw new Error(`GitHub API request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return await response.json() as T;
}

function githubIdentityForTools(identity?: GitHubIdentity): GitHubIdentity | undefined {
  return identity;
}

function createAppServer(identity?: GitHubIdentity): McpServer {
  const server = new McpServer({ name: "everything-chatgpt", version: "0.3.0" });
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

  registerAppTool(server, "github_search_repositories", {
    title: "Search GitHub repositories",
    description: "Use this when the user wants to find GitHub repositories by name, topic, language, or other GitHub search qualifiers. This is read-only.",
    inputSchema: { query: z.string().min(1).max(MAX_GITHUB_QUERY_CHARS).describe("GitHub repository search query, for example jarvis-os language:kotlin.") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Searching GitHub repositories", "openai/toolInvocation/invoked": "GitHub repository search complete" },
  }, async ({ query }): Promise<ToolResult> => {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("GitHub search query cannot be empty.");
    const payload = await githubApi<{ total_count: number; items: Array<{ full_name: string; name: string; html_url: string; description?: string | null; private: boolean; default_branch: string; stargazers_count: number; language?: string | null }> }>(`/search/repositories?q=${encodeURIComponent(trimmed)}&per_page=${MAX_GITHUB_RESULTS}`, githubIdentityForTools(identity));
    const results = payload.items.slice(0, MAX_GITHUB_RESULTS).map((item) => ({
      fullName: item.full_name, name: item.name, url: item.html_url, description: item.description ?? "", private: item.private,
      defaultBranch: item.default_branch, stars: item.stargazers_count, language: item.language ?? null,
    }));
    return {
      content: [{ type: "text", text: `Found ${results.length} GitHub repository result(s) for “${trimmed}”.` }],
      structuredContent: { view: "github-repositories", headline: `GitHub repositories: ${trimmed}`, totalCount: payload.total_count, results },
      _meta: { "openai/outputTemplate": WIDGET_URI },
    };
  });

  registerAppTool(server, "github_get_repository", {
    title: "Inspect a GitHub repository",
    description: "Use this when the user gives an owner and repository name and wants repository metadata. This is read-only.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Inspecting GitHub repository", "openai/toolInvocation/invoked": "GitHub repository metadata ready" },
  }, async ({ owner, repo }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const item = await githubApi<{ full_name: string; html_url: string; description?: string | null; private: boolean; default_branch: string; language?: string | null; stargazers_count: number; forks_count: number; open_issues_count: number; pushed_at?: string | null }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`, githubIdentityForTools(identity));
    const result = { fullName: item.full_name, url: item.html_url, description: item.description ?? "", private: item.private, defaultBranch: item.default_branch, language: item.language ?? null, stars: item.stargazers_count, forks: item.forks_count, openIssues: item.open_issues_count, pushedAt: item.pushed_at ?? null };
    return { content: [{ type: "text", text: `GitHub repository metadata is ready for ${item.full_name}.` }], structuredContent: { view: "github-repository", headline: item.full_name, repository: result }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_list_tree", {
    title: "List GitHub repository files",
    description: "Use this when the user wants to inspect the files and directories in a GitHub repository. This is read-only and returns a bounded listing.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      path: z.string().max(MAX_GITHUB_PATH_CHARS).optional().describe("Optional directory path inside the repository."),
      ref: z.string().max(256).optional().describe("Optional branch, tag, or commit SHA."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Listing GitHub repository files", "openai/toolInvocation/invoked": "GitHub file listing ready" },
  }, async ({ owner, repo, path: requestedPath, ref }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const cleanPath = requestedPath ? githubFilePath(requestedPath) : "";
    const cleanRef = githubRef(ref);
    const repositoryInfo = await githubApi<{ default_branch: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`, githubIdentityForTools(identity));
    const effectiveRef = cleanRef || repositoryInfo.default_branch;
    const payload = await githubApi<{ tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number; url: string }>; truncated?: boolean }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(effectiveRef)}?recursive=1`, githubIdentityForTools(identity));
    const matchingEntries = payload.tree.filter((entry) => !cleanPath || entry.path === cleanPath || entry.path.startsWith(`${cleanPath}/`));
    const entries = matchingEntries.slice(0, MAX_GITHUB_TREE_ENTRIES).map((entry) => ({ path: entry.path, type: entry.type, sha: entry.sha, size: entry.size ?? null, url: entry.url }));
    const truncated = Boolean(payload.truncated) || matchingEntries.length > MAX_GITHUB_TREE_ENTRIES;
    return { content: [{ type: "text", text: `Listed ${entries.length} GitHub file entr${entries.length === 1 ? "y" : "ies"} for ${repository.owner}/${repository.repo}.` }], structuredContent: { view: "github-tree", headline: `${repository.owner}/${repository.repo}`, path: cleanPath || "/", ref: effectiveRef, truncated, entries }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_read_file", {
    title: "Read a GitHub file",
    description: "Use this when the user wants to inspect the contents of a text file in a GitHub repository. This is read-only, bounded, and never executes the file.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      path: z.string().min(1).max(MAX_GITHUB_PATH_CHARS).describe("File path inside the repository."),
      ref: z.string().max(256).optional().describe("Optional branch, tag, or commit SHA."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Reading GitHub file", "openai/toolInvocation/invoked": "GitHub file contents ready" },
  }, async ({ owner, repo, path: requestedPath, ref }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const cleanPath = githubFilePath(requestedPath);
    const cleanRef = githubRef(ref);
    const query = cleanRef ? `?ref=${encodeURIComponent(cleanRef)}` : "";
    const payload = await githubApi<{ type: string; encoding: string; content?: string; size?: number; path: string; sha: string; html_url?: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/${cleanPath.split("/").map(encodeURIComponent).join("/")}${query}`, githubIdentityForTools(identity));
    if (payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") throw new Error("The requested GitHub path is not a supported text file.");
    const decoded = Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
    const content = decoded.slice(0, MAX_FILE_CHARS);
    const truncated = decoded.length > content.length;
    return { content: [{ type: "text", text: `GitHub file ${payload.path}${truncated ? ` (first ${MAX_FILE_CHARS.toLocaleString()} characters)` : ""}\n\n${content}` }], structuredContent: { view: "github-file", headline: `${repository.owner}/${repository.repo}/${payload.path}`, path: payload.path, ref: cleanRef || "default", sha: payload.sha, content, truncated, url: payload.html_url ?? null }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  return server;
}

const port = Number(process.env.PORT ?? "8787");
const MCP_PATH = "/mcp";

function requestId(req: IncomingMessage): string {
  return req.headers["x-request-id"]?.toString().slice(0, 100) || crypto.randomUUID();
}

function logEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function oauthConfigured(): boolean {
  return OAUTH_ENABLED && Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_CALLBACK_URL);
}

function oauthError(res: ServerResponse, status: number, error: string, description: string, redirectUri?: string, state?: string) {
  if (redirectUri) {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", error);
    redirect.searchParams.set("error_description", description);
    if (state) redirect.searchParams.set("state", state);
    res.writeHead(302, { location: redirect.toString() }).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error, error_description: description }));
}

function normalizeScope(scope: string | null): string {
  const requested = (scope ?? OAUTH_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  return Array.from(new Set(requested.filter((item) => OAUTH_SCOPES.includes(item as typeof OAUTH_SCOPES[number])))).join(" ") || OAUTH_SCOPES[0];
}

function isAllowedOAuthRedirect(uri: string): boolean {
  const configured = (process.env.ECG_OAUTH_REDIRECT_URIS ?? "https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/")
    .split(",").map((item) => item.trim()).filter(Boolean);
  return configured.some((allowed) => allowed.endsWith("/") ? uri.startsWith(allowed) : uri === allowed);
}

async function exchangeGitHubCode(code: string): Promise<GitHubIdentity> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_CALLBACK_URL }),
  });
  if (!tokenResponse.ok) throw new Error(`GitHub token exchange failed with ${tokenResponse.status}`);
  const tokenPayload = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenPayload.access_token) throw new Error(tokenPayload.error || "GitHub did not return an access token.");

  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${tokenPayload.access_token}`, "x-github-api-version": "2022-11-28" };
  const userResponse = await fetch("https://api.github.com/user", { headers });
  if (!userResponse.ok) throw new Error(`GitHub identity lookup failed with ${userResponse.status}`);
  const user = await userResponse.json() as { id: number; login: string; name?: string | null; email?: string | null };
  return { id: user.id, login: user.login, name: user.name, email: user.email, githubAccessToken: tokenPayload.access_token };
}

function protectedResourceMetadata() {
  return {
    resource: PUBLIC_RESOURCE_URL,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...OAUTH_SCOPES],
    resource_documentation: `${PUBLIC_RESOURCE_URL}/`,
  };
}

function authorizationServerMetadata() {
  return {
    issuer: OAUTH_ISSUER,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${OAUTH_ISSUER}/oauth/authorize`,
    token_endpoint: `${OAUTH_ISSUER}/oauth/token`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: [...OAUTH_SCOPES],
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders }).end(JSON.stringify(payload));
}

function applySecurityHeaders(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Request-Id");
  res.setHeader("X-Request-Id", requestId(req));
}

function clientKey(req: IncomingMessage): string {
  return req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function isRateLimited(req: IncomingMessage): boolean {
  const now = Date.now();
  const key = clientKey(req);
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_MAX_REQUESTS;
}

function bearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function hasValidAccessToken(req: IncomingMessage): boolean {
  if (OAUTH_ENABLED) {
    const token = oauthAccessTokens.get(bearerToken(req));
    return Boolean(token && token.expiresAt > Date.now() && token.resource === PUBLIC_RESOURCE_URL && token.scope.split(" ").includes("ecg:read"));
  }
  if (!ACCESS_TOKEN) return true;
  const presented = bearerToken(req);
  const expected = Buffer.from(ACCESS_TOKEN);
  const actual = Buffer.from(presented);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function authenticatedIdentity(req: IncomingMessage): GitHubIdentity | undefined {
  if (!OAUTH_ENABLED) return undefined;
  const token = oauthAccessTokens.get(bearerToken(req));
  if (!token || token.expiresAt <= Date.now() || token.resource !== PUBLIC_RESOURCE_URL || !token.scope.split(" ").includes("ecg:read")) return undefined;
  return token.identity;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) reject(new Error("Request too large")); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === `${MCP_PATH}/.well-known/oauth-protected-resource`) {
    sendJson(res, 200, protectedResourceMetadata());
    return true;
  }
  if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
    sendJson(res, 200, authorizationServerMetadata());
    return true;
  }
  if (!OAUTH_ENABLED) return false;
  if (!oauthConfigured()) {
    if (url.pathname.startsWith("/oauth/")) sendJson(res, 503, { error: "temporarily_unavailable", error_description: "OAuth is enabled but its GitHub credentials are not configured." });
    return url.pathname.startsWith("/oauth/");
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type");
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const method = url.searchParams.get("code_challenge_method");
    const resource = url.searchParams.get("resource") ?? PUBLIC_RESOURCE_URL;
    const scope = normalizeScope(url.searchParams.get("scope"));
    const state = url.searchParams.get("state") ?? undefined;
    if (responseType !== "code" || !clientId || !redirectUri || !isAllowedOAuthRedirect(redirectUri) || !codeChallenge || method !== "S256" || resource !== PUBLIC_RESOURCE_URL) {
      oauthError(res, 400, "invalid_request", "A valid authorization-code request with PKCE and the registered resource is required.", isAllowedOAuthRedirect(redirectUri) ? redirectUri : undefined, state);
      return true;
    }
    const oauthState = randomToken();
    oauthStates.set(oauthState, { clientId, redirectUri, scope, resource, codeChallenge, state, createdAt: Date.now() });
    const github = new URL("https://github.com/login/oauth/authorize");
    github.searchParams.set("client_id", GITHUB_CLIENT_ID);
    github.searchParams.set("redirect_uri", GITHUB_CALLBACK_URL);
    github.searchParams.set("scope", "read:user user:email");
    github.searchParams.set("state", oauthState);
    res.writeHead(302, { location: github.toString() }).end();
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/github/callback") {
    const stateKey = url.searchParams.get("state") ?? "";
    const pending = oauthStates.get(stateKey);
    oauthStates.delete(stateKey);
    if (!pending || pending.createdAt + OAUTH_CODE_TTL_MS < Date.now()) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("OAuth state expired or invalid.");
      return true;
    }
    const githubError = url.searchParams.get("error");
    if (githubError) { oauthError(res, 400, githubError, url.searchParams.get("error_description") || "GitHub authorization was denied.", pending.redirectUri, pending.state); return true; }
    try {
      const identity = await exchangeGitHubCode(url.searchParams.get("code") ?? "");
      const authorizationCode = randomToken();
      oauthCodes.set(authorizationCode, { ...pending, identity, used: false });
      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set("code", authorizationCode);
      if (pending.state) redirect.searchParams.set("state", pending.state);
      redirect.searchParams.set("iss", OAUTH_ISSUER);
      res.writeHead(302, { location: redirect.toString() }).end();
    } catch (error) {
      logEvent("oauth.github_error", { error: error instanceof Error ? error.message : String(error) });
      oauthError(res, 502, "server_error", "GitHub authentication could not be completed.", pending.redirectUri, pending.state);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    let params: URLSearchParams;
    try { params = new URLSearchParams(await readBody(req)); } catch { sendJson(res, 413, { error: "invalid_request" }); return true; }
    const grantType = params.get("grant_type");
    const resource = params.get("resource") ?? PUBLIC_RESOURCE_URL;
    if (resource !== PUBLIC_RESOURCE_URL) { sendJson(res, 400, { error: "invalid_target" }); return true; }
    if (grantType === "authorization_code") {
      const code = params.get("code") ?? "";
      const verifier = params.get("code_verifier") ?? "";
      const pending = oauthCodes.get(code);
      const digest = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!pending || pending.used || pending.createdAt + OAUTH_CODE_TTL_MS < Date.now() || digest !== pending.codeChallenge || params.get("redirect_uri") !== pending.redirectUri) {
        sendJson(res, 400, { error: "invalid_grant" });
        return true;
      }
      pending.used = true;
      const accessToken = randomToken();
      const refreshToken = randomToken();
      oauthAccessTokens.set(accessToken, { identity: pending.identity, scope: pending.scope, resource, expiresAt: Date.now() + OAUTH_TOKEN_TTL_MS });
      oauthRefreshTokens.set(refreshToken, { identity: pending.identity, scope: pending.scope, resource, expiresAt: Date.now() + OAUTH_REFRESH_TTL_MS });
      sendJson(res, 200, { token_type: "Bearer", access_token: accessToken, expires_in: OAUTH_TOKEN_TTL_MS / 1000, refresh_token: refreshToken, scope: pending.scope });
      return true;
    }
    if (grantType === "refresh_token") {
      const previous = oauthRefreshTokens.get(params.get("refresh_token") ?? "");
      if (!previous || previous.expiresAt < Date.now()) { sendJson(res, 400, { error: "invalid_grant" }); return true; }
      const accessToken = randomToken();
      oauthAccessTokens.set(accessToken, { identity: previous.identity, scope: previous.scope, resource, expiresAt: Date.now() + OAUTH_TOKEN_TTL_MS });
      sendJson(res, 200, { token_type: "Bearer", access_token: accessToken, expires_in: OAUTH_TOKEN_TTL_MS / 1000, scope: previous.scope });
      return true;
    }
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return true;
  }
  return false;
}

createServer(async (req, res) => {
  const startedAt = Date.now();
  const id = requestId(req);
  applySecurityHeaders(req, res);
  if (!req.url) { res.writeHead(400).end("Missing URL"); return; }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const isMcpRoute = url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`);
  logEvent("request.started", { id, method: req.method, path: url.pathname });
  res.on("finish", () => logEvent("request.finished", { id, method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt }));

  if (await handleOAuth(req, res, url)) return;

  if (isMcpRoute && req.method !== "OPTIONS" && isRateLimited(req)) {
    res.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": "60" }).end("Rate limit exceeded");
    return;
  }
  if (isMcpRoute && req.method !== "OPTIONS" && !hasValidAccessToken(req)) {
    const challenge = OAUTH_ENABLED
      ? `Bearer resource_metadata="${PUBLIC_RESOURCE_URL}/.well-known/oauth-protected-resource", scope="ecg:read"`
      : "Bearer";
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "www-authenticate": challenge }).end("Authentication required");
    return;
  }

  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    res.writeHead(413, { "content-type": "text/plain" }).end("Request too large");
    return;
  }

  if (req.method === "OPTIONS" && isMcpRoute) {
    res.writeHead(204, { "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization, x-request-id" }).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Everything ChatGPT MCP server");
    return;
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ status: "ok", service: "everything-chatgpt" }));
    return;
  }
  if (isMcpRoute && req.method && MCP_METHODS.has(req.method)) {
    const server = createAppServer(authenticatedIdentity(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch (error) {
      logEvent("request.error", { id, method: req.method, path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }
  res.writeHead(404).end("Not Found");
}).listen(port, () => console.log(`Everything ChatGPT MCP server listening on http://localhost:${port}${MCP_PATH}`));
