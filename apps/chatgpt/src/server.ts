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
import { EncryptedJsonStore } from "./encrypted-store.js";
import { runSandboxedTest } from "./sandbox.js";
import { planWorkflow } from "./workflow.js";

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
const MAX_GITHUB_COMMITS = 20;
const MAX_GITHUB_DIFF_CHARS = 32_000;
const MAX_GITHUB_PATCH_CHARS = 16_000;
const MAX_GITHUB_PATCH_FILES = 10;
const MAX_GITHUB_PATCH_TOTAL_CHARS = 64_000;
const MAX_GITHUB_FALLBACK_FILES = 32;
const MAX_GITHUB_FALLBACK_CHARS = 128_000;
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
const oauthStates = new EncryptedJsonStore<OAuthState>("oauth-states");
const oauthCodes = new EncryptedJsonStore<OAuthCode>("oauth-codes");
const oauthAccessTokens = new EncryptedJsonStore<OAuthToken>("oauth-access-tokens");
const oauthRefreshTokens = new EncryptedJsonStore<OAuthRefreshToken>("oauth-refresh-tokens");
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

type GitHubIdentity = { id: number; login: string; name?: string | null; email?: string | null; githubAccessToken?: string; ecgScope?: string };
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

function githubBranchName(value: string): string {
  const branch = value.trim();
  if (!branch || branch.length > 256 || branch.startsWith("/") || branch.endsWith("/") || branch.includes("..") || branch.includes("//") || /[\u0000-\u001f\u007f ~^:?*[\\]/.test(branch)) {
    throw new Error("Invalid GitHub branch name.");
  }
  return branch;
}

type GitHubRequestOptions = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown };

async function githubApi<T>(apiPath: string, identity?: GitHubIdentity, options: GitHubRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "everything-chatgpt/0.5.0",
  };
  if (identity?.githubAccessToken) headers.authorization = `Bearer ${identity.githubAccessToken}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`https://api.github.com${apiPath}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) throw new Error("GitHub authorization does not allow this repository or the GitHub rate limit was reached.");
    if (response.status === 404) throw new Error("GitHub repository or resource was not found, or it is not accessible to this account.");
    throw new Error(`GitHub API request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return await response.json() as T;
}

async function githubGraphql<T>(query: string, variables: Record<string, unknown>, identity: GitHubIdentity): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${identity.githubAccessToken}`, "x-github-api-version": "2022-11-28", "user-agent": "everything-chatgpt/0.5.0" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || `GitHub GraphQL request failed with HTTP ${response.status}`);
  if (!payload.data) throw new Error("GitHub GraphQL returned no data.");
  return payload.data;
}

function githubIdentityForTools(identity?: GitHubIdentity): GitHubIdentity | undefined {
  return identity;
}

function requireGitHubWriteIdentity(identity?: GitHubIdentity): GitHubIdentity {
  if (!identity?.githubAccessToken) {
    throw new Error("GitHub write access is not authorized. Reconnect ECG TOOL and approve GitHub repository access before creating branches or pull requests.");
  }
  if (process.env.ECG_ENABLE_WRITES === "false") throw new Error("GitHub write operations are disabled by server policy.");
  return identity;
}

function assertRepositoryPolicy(repository: { owner: string; repo: string }, operation: "read" | "write"): void {
  const configured = (process.env.ECG_ALLOWED_REPOSITORIES ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (configured.length > 0 && !configured.includes(`${repository.owner}/${repository.repo}`.toLowerCase())) {
    throw new Error(`This repository is outside ECG_ALLOWED_REPOSITORIES for ${operation} operations.`);
  }
  if (operation === "write" && process.env.ECG_ENABLE_WRITES === "false") throw new Error("GitHub write operations are disabled by server policy.");
}

type PatchOperation = "create" | "update" | "delete";
type PatchChange = { path: string; operation: PatchOperation; content?: string; expectedSha?: string };

function validatePatchChanges(changes: PatchChange[]): PatchChange[] {
  if (changes.length < 1 || changes.length > MAX_GITHUB_PATCH_FILES) throw new Error(`A patch proposal must contain between 1 and ${MAX_GITHUB_PATCH_FILES} files.`);
  const seen = new Set<string>();
  let totalChars = 0;
  return changes.map((change) => {
    const cleanPath = githubFilePath(change.path);
    if (seen.has(cleanPath)) throw new Error(`Patch contains the file more than once: ${cleanPath}`);
    seen.add(cleanPath);
    const content = change.operation === "delete" ? undefined : change.content ?? "";
    if ((content?.length ?? 0) > MAX_GITHUB_PATCH_CHARS) throw new Error(`Patch content exceeds ${MAX_GITHUB_PATCH_CHARS.toLocaleString()} characters: ${cleanPath}`);
    if (change.operation !== "create" && !change.expectedSha) throw new Error(`Patch operation ${change.operation} requires expectedSha for ${cleanPath}.`);
    if (change.operation === "create" && change.expectedSha) throw new Error(`Create operation must not include expectedSha: ${cleanPath}`);
    totalChars += content?.length ?? 0;
    if (totalChars > MAX_GITHUB_PATCH_TOTAL_CHARS) throw new Error(`Patch proposal exceeds ${MAX_GITHUB_PATCH_TOTAL_CHARS.toLocaleString()} total content characters.`);
    return { path: cleanPath, operation: change.operation, ...(content === undefined ? {} : { content }), ...(change.expectedSha ? { expectedSha: change.expectedSha } : {}) };
  });
}

function previewPatch(pathname: string, operation: PatchOperation, previous: string, next: string): string {
  const oldLines = previous ? previous.split("\n") : [];
  const newLines = next ? next.split("\n") : [];
  const oldPreview = oldLines.slice(0, 120).map((line) => `-${line}`).join("\n");
  const newPreview = newLines.slice(0, 120).map((line) => `+${line}`).join("\n");
  const omitted = oldLines.length > 120 || newLines.length > 120 ? "\n... preview truncated ..." : "";
  return [`--- ${operation === "create" ? "/dev/null" : `a/${pathname}`}`, `+++ ${operation === "delete" ? "/dev/null" : `b/${pathname}`}`, "@@", oldPreview, newPreview].filter(Boolean).join("\n") + omitted;
}

async function readGitHubTextFile(owner: string, repo: string, pathname: string, ref: string, identity?: GitHubIdentity): Promise<{ content: string; sha: string } | undefined> {
  try {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const payload = await githubApi<{ type: string; encoding: string; content?: string; sha: string }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${pathname.split("/").map(encodeURIComponent).join("/")}${query}`, identity);
    if (payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") throw new Error(`GitHub path is not a text file: ${pathname}`);
    return { content: Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8"), sha: payload.sha };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub repository or resource was not found")) return undefined;
    throw error;
  }
}

function githubCodeSearchTerms(query: string): string[] {
  return query
    .replace(/repo:[^\s]+/gi, " ")
    .replace(/\b(?:path|language|extension|filename):[^\s]+/gi, " ")
    .replace(/["']/g, " ")
    .split(/\s+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

function isLikelyTextPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return !/\.(7z|avi|bmp|class|dll|doc|docx|exe|gif|ico|jar|jpeg|jpg|mov|mp3|mp4|pdf|png|so|tar|ttf|wav|webm|woff2?|zip)$/i.test(lower);
}

function fallbackPathPriority(pathname: string): number {
  const lower = pathname.toLowerCase();
  let score = 0;
  if (lower.startsWith("src/") || lower.includes("/src/")) score += 40;
  if (lower.startsWith("app/") || lower.includes("/app/") || lower.startsWith("apps/")) score += 30;
  if (lower.startsWith("lib/") || lower.includes("/lib/")) score += 20;
  if (lower.startsWith("scripts/") || lower.includes("/scripts/")) score += 15;
  if (lower.startsWith("tests/") || lower.includes("/tests/")) score += 10;
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|json|yaml|yml|md)$/i.test(lower)) score += 5;
  return score;
}

async function fallbackGitHubCodeSearch(repository: { owner: string; repo: string }, query: string, ref: string, identity?: GitHubIdentity) {
  const terms = githubCodeSearchTerms(query);
  if (terms.length === 0) return { results: [], scannedFiles: 0, scannedChars: 0 };
  const tree = await githubApi<{ tree: Array<{ path: string; type: string; sha: string; url: string }>; truncated?: boolean }>(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    identity,
  );
  const candidates = tree.tree
    .filter((entry) => entry.type === "blob" && isLikelyTextPath(entry.path))
    .sort((left, right) => fallbackPathPriority(right.path) - fallbackPathPriority(left.path) || left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, MAX_GITHUB_FALLBACK_FILES);
  const results: Array<{ name: string; path: string; sha: string; url: string; repository: string; snippet: string }> = [];
  let scannedChars = 0;
  let scannedFiles = 0;
  const stopAfterFirst = terms.length === 1 && /^[a-z_$][\w$.-]*$/i.test(terms[0]);
  for (const candidate of candidates) {
    if (scannedChars >= MAX_GITHUB_FALLBACK_CHARS || results.length >= MAX_GITHUB_RESULTS) break;
    if (stopAfterFirst && results.length > 0) break;
    scannedFiles += 1;
    const file = await readGitHubTextFile(repository.owner, repository.repo, candidate.path, ref, identity);
    if (!file) continue;
    const content = file.content.slice(0, Math.max(0, MAX_GITHUB_FALLBACK_CHARS - scannedChars));
    scannedChars += content.length;
    const lowerContent = content.toLowerCase();
    if (!terms.every((term) => lowerContent.includes(term))) continue;
    const firstTermIndex = lowerContent.indexOf(terms[0]);
    const start = Math.max(0, firstTermIndex - 120);
    results.push({
      name: candidate.path.split("/").pop() ?? candidate.path,
      path: candidate.path,
      sha: file.sha,
      url: `https://github.com/${repository.owner}/${repository.repo}/blob/${encodeURIComponent(ref)}/${candidate.path.split("/").map(encodeURIComponent).join("/")}`,
      repository: `${repository.owner}/${repository.repo}`,
      snippet: content.slice(start, start + 360).replace(/\s+/g, " ").trim(),
    });
  }
  return { results, scannedFiles, scannedChars };
}

function createAppServer(identity?: GitHubIdentity): McpServer {
  const server = new McpServer({ name: "everything-chatgpt", version: "0.5.0" }, {
    instructions: "Use read tools to inspect repositories and PRs. Before any GitHub write or sandbox execution, obtain explicit approval for the exact target, content, and action. Never merge automatically. Read the most relevant ECG skills before implementation.",
  });
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

  registerAppTool(server, "github_list_commits", {
    title: "Read GitHub commit history",
    description: "Use this when the user wants to review recent commits in a GitHub repository or the history of a specific path. This is read-only.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      ref: z.string().max(256).optional().describe("Optional branch, tag, or commit SHA."),
      path: z.string().max(MAX_GITHUB_PATH_CHARS).optional().describe("Optional file or directory path to filter history."),
      limit: z.number().int().min(1).max(MAX_GITHUB_COMMITS).optional().describe(`Maximum commits to return, up to ${MAX_GITHUB_COMMITS}.`),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Reading GitHub commit history", "openai/toolInvocation/invoked": "GitHub commit history ready" },
  }, async ({ owner, repo, ref, path: requestedPath, limit }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const cleanRef = githubRef(ref);
    const cleanPath = requestedPath ? githubFilePath(requestedPath) : "";
    const params = new URLSearchParams({ per_page: String(limit ?? MAX_GITHUB_COMMITS) });
    if (cleanRef) params.set("sha", cleanRef);
    if (cleanPath) params.set("path", cleanPath);
    const commits = await githubApi<Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } | null }; author?: { login: string } | null }>>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits?${params.toString()}`, githubIdentityForTools(identity));
    const results = commits.slice(0, limit ?? MAX_GITHUB_COMMITS).map((item) => ({ sha: item.sha, url: item.html_url, message: item.commit.message.split("\n")[0].slice(0, 240), author: item.author?.login ?? item.commit.author?.name ?? "unknown", date: item.commit.author?.date ?? null }));
    return { content: [{ type: "text", text: `Found ${results.length} GitHub commit(s) for ${repository.owner}/${repository.repo}.` }], structuredContent: { view: "github-commits", headline: `${repository.owner}/${repository.repo} commits`, ref: cleanRef || "default", path: cleanPath || null, results }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_compare_commits", {
    title: "Compare GitHub commits",
    description: "Use this when the user wants to review the diff between two GitHub branches, tags, or commit SHAs. This is read-only and returns a bounded diff.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      base: z.string().min(1).max(256).describe("Base branch, tag, or commit SHA."),
      head: z.string().min(1).max(256).describe("Head branch, tag, or commit SHA."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Comparing GitHub commits", "openai/toolInvocation/invoked": "GitHub diff ready" },
  }, async ({ owner, repo, base, head }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const cleanBase = githubRef(base);
    const cleanHead = githubRef(head);
    if (!cleanBase || !cleanHead) throw new Error("Both base and head refs are required.");
    const payload = await githubApi<{ status: string; ahead_by: number; behind_by: number; total_commits: number; html_url: string; commits: Array<{ sha: string; commit: { message: string } }>; files?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string | null; blob_url?: string }> }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/compare/${encodeURIComponent(cleanBase)}...${encodeURIComponent(cleanHead)}`, githubIdentityForTools(identity));
    let remaining = MAX_GITHUB_DIFF_CHARS;
    const files = (payload.files ?? []).map((file) => {
      const patch = (file.patch ?? "").slice(0, Math.max(0, remaining));
      remaining -= patch.length;
      return { filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, patch, truncated: Boolean(file.patch && patch.length < file.patch.length), url: file.blob_url ?? null };
    });
    return { content: [{ type: "text", text: `Compared ${repository.owner}/${repository.repo}: ${cleanBase} to ${cleanHead}.` }], structuredContent: { view: "github-diff", headline: `${repository.owner}/${repository.repo}: ${cleanBase} → ${cleanHead}`, url: payload.html_url, status: payload.status, aheadBy: payload.ahead_by, behindBy: payload.behind_by, totalCommits: payload.total_commits, commits: payload.commits.slice(0, MAX_GITHUB_COMMITS).map((commit) => ({ sha: commit.sha, message: commit.commit.message.split("\n")[0].slice(0, 240) })), files, truncated: remaining <= 0 }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_search_code", {
    title: "Search GitHub repository content",
    description: "Use this when the user wants to find text or symbols inside a specific GitHub repository. This is read-only and uses GitHub code-search qualifiers.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      query: z.string().min(1).max(MAX_GITHUB_QUERY_CHARS).describe("Text, symbol, or GitHub code-search qualifier to find."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Searching GitHub code", "openai/toolInvocation/invoked": "GitHub code search complete" },
  }, async ({ owner, repo, query }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const trimmed = query.trim();
    let payload: { total_count: number; incomplete_results: boolean; items: Array<{ name: string; path: string; sha: string; html_url: string; repository?: { full_name: string } }> };
    let apiFallbackReason: string | null = null;
    try {
      payload = await githubApi<{ total_count: number; incomplete_results: boolean; items: Array<{ name: string; path: string; sha: string; html_url: string; repository?: { full_name: string } }> }>(`/search/code?q=${encodeURIComponent(`${trimmed} repo:${repository.owner}/${repository.repo}`)}&per_page=${MAX_GITHUB_RESULTS}`, githubIdentityForTools(identity));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("GitHub authorization")) throw error;
      payload = { total_count: 0, incomplete_results: true, items: [] };
      apiFallbackReason = error.message;
    }
    let results = payload.items.slice(0, MAX_GITHUB_RESULTS).map((item) => ({ name: item.name, path: item.path, sha: item.sha, url: item.html_url, repository: item.repository?.full_name ?? `${repository.owner}/${repository.repo}`, snippet: null as string | null }));
    let fallbackUsed = false;
    let fallbackScannedFiles = 0;
    let fallbackScannedChars = 0;
    if (payload.incomplete_results && results.length === 0) {
      const repositoryInfo = await githubApi<{ default_branch: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`, githubIdentityForTools(identity));
      const fallback = await fallbackGitHubCodeSearch(repository, trimmed, repositoryInfo.default_branch, githubIdentityForTools(identity));
      results = fallback.results;
      fallbackUsed = true;
      fallbackScannedFiles = fallback.scannedFiles;
      fallbackScannedChars = fallback.scannedChars;
    }
    const status = fallbackUsed ? `${apiFallbackReason ? "GitHub code search was unavailable, so" : "GitHub returned an incomplete zero-result response, so"} ECG scanned ${fallbackScannedFiles} bounded text file(s) locally and found ${results.length} match(es).` : `Found ${results.length} GitHub code result(s) for “${trimmed}”.`;
    return { content: [{ type: "text", text: status }], structuredContent: { view: "github-code-search", headline: `${repository.owner}/${repository.repo}: ${trimmed}`, totalCount: payload.total_count, incomplete: payload.incomplete_results, fallbackUsed, fallbackScannedFiles, fallbackScannedChars, results }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_get_pull_request", {
    title: "Inspect a GitHub pull request",
    description: "Use this when the user wants the status, branches, checks, mergeability, or files of an existing pull request. This is read-only.",
    inputSchema: { owner: z.string().min(1).max(128), repo: z.string().min(1).max(128), number: z.number().int().min(1).max(100000) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
  }, async ({ owner, repo, number }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const pull = await githubApi<{ number: number; title: string; body: string | null; state: string; draft: boolean; html_url: string; mergeable: boolean | null; mergeable_state: string; head: { ref: string; sha: string }; base: { ref: string; sha: string }; changed_files: number; additions: number; deletions: number; commits: number; requested_reviewers?: Array<{ login: string }> }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${number}`, githubIdentityForTools(identity));
    return { content: [{ type: "text", text: `GitHub PR #${pull.number}: ${pull.title}. Mergeability is ${pull.mergeable_state}.` }], structuredContent: { view: "github-pull-request-detail", ...pull, requestedReviewers: (pull.requested_reviewers ?? []).map((reviewer) => reviewer.login) }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_list_pull_request_reviews", {
    title: "Read GitHub pull-request review activity",
    description: "Use this when the user wants reviews, review comments, conversation comments, or unresolved review threads for a pull request. This is read-only.",
    inputSchema: { owner: z.string().min(1).max(128), repo: z.string().min(1).max(128), number: z.number().int().min(1).max(100000) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
  }, async ({ owner, repo, number }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const [reviews, reviewComments, issueComments] = await Promise.all([
      githubApi<Array<{ id: number; node_id?: string; user?: { login: string }; body: string | null; state: string; submitted_at: string | null; html_url: string }>>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${number}/reviews`, githubIdentityForTools(identity)),
      githubApi<Array<{ id: number; node_id?: string; user?: { login: string }; body: string; path: string; line: number | null; side?: string; in_reply_to_id?: number; created_at: string; html_url: string }>>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${number}/comments`, githubIdentityForTools(identity)),
      githubApi<Array<{ id: number; user?: { login: string }; body: string; created_at: string; html_url: string }>>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues/${number}/comments`, githubIdentityForTools(identity)),
    ]);
    let threads: Array<{ id: string; isResolved: boolean; path?: string; line?: number | null }> = [];
    try {
      const data = await githubGraphql<{ repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string; isResolved: boolean; path: string; line: number | null }> } } } }>(`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line}}}}}`, { owner: repository.owner, repo: repository.repo, number }, requireGitHubWriteIdentity(identity));
      threads = data.repository.pullRequest.reviewThreads.nodes;
    } catch { /* Fine-grained tokens may not have GraphQL thread access; REST reviews remain useful. */ }
    return { content: [{ type: "text", text: `Found ${reviews.length} review(s), ${reviewComments.length} inline comment(s), and ${issueComments.length} conversation comment(s) on PR #${number}.` }], structuredContent: { view: "github-pull-request-reviews", reviews, reviewComments, issueComments, threads, unresolvedThreads: threads.filter((thread) => !thread.isResolved) }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_update_pull_request", {
    title: "Update a GitHub pull request",
    description: "Use this only after explicit approval of the exact PR number and fields. Updates title, body, target branch, or open/closed state; it never merges a PR.",
    inputSchema: { owner: z.string().min(1).max(128), repo: z.string().min(1).max(128), number: z.number().int().min(1).max(100000), title: z.string().min(1).max(256).optional(), body: z.string().max(16000).optional(), base: z.string().max(256).optional(), state: z.enum(["open", "closed"]).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI } },
  }, async ({ owner, repo, number, title, body, base, state }): Promise<ToolResult> => {
    const writeIdentity = requireGitHubWriteIdentity(identity);
    const repository = githubRepository(owner, repo); assertRepositoryPolicy(repository, "write");
    const pull = await githubApi<{ number: number; title: string; body: string | null; state: string; html_url: string; head: { ref: string }; base: { ref: string } }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${number}`, writeIdentity, { method: "PATCH", body: { ...(title === undefined ? {} : { title: title.trim() }), ...(body === undefined ? {} : { body: body.trim() }), ...(base === undefined ? {} : { base: githubBranchName(base) }), ...(state === undefined ? {} : { state }) } });
    return { content: [{ type: "text", text: `Updated GitHub PR #${pull.number}: ${pull.title}. It was not merged.` }], structuredContent: { view: "github-pull-request", number: pull.number, title: pull.title, body: pull.body, state: pull.state, url: pull.html_url, head: pull.head.ref, base: pull.base.ref }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_create_pull_request_review", {
    title: "Submit a GitHub pull-request review",
    description: "Use this only after explicit approval of the repository, PR number, review event, and exact review text. Can submit a comment, approval, or change request without merging.",
    inputSchema: { owner: z.string().min(1).max(128), repo: z.string().min(1).max(128), number: z.number().int().min(1).max(100000), commitId: z.string().min(7).max(64), body: z.string().max(16000), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), comments: z.array(z.object({ path: z.string().min(1).max(MAX_GITHUB_PATH_CHARS), line: z.number().int().min(1).max(100000), side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"), body: z.string().min(1).max(4000) })).max(20).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI } },
  }, async ({ owner, repo, number, commitId, body, event, comments }): Promise<ToolResult> => {
    const writeIdentity = requireGitHubWriteIdentity(identity);
    const repository = githubRepository(owner, repo); assertRepositoryPolicy(repository, "write");
    const review = await githubApi<{ id: number; html_url: string; state: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${number}/reviews`, writeIdentity, { method: "POST", body: { commit_id: commitId, body: body.trim(), event, comments: comments?.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body })) ?? [] } });
    return { content: [{ type: "text", text: `Submitted ${event.toLowerCase()} review ${review.id} on PR #${number}.` }], structuredContent: { view: "github-review", id: review.id, state: review.state, url: review.html_url, pullRequest: number }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_resolve_review_thread", {
    title: "Resolve a GitHub review thread",
    description: "Use this only after explicit approval of the exact GitHub review-thread node ID. This marks an existing review thread resolved; it does not change code or merge the PR.",
    inputSchema: { threadId: z.string().min(10).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI } },
  }, async ({ threadId }): Promise<ToolResult> => {
    const writeIdentity = requireGitHubWriteIdentity(identity);
    const data = await githubGraphql<{ resolveReviewThread: { thread: { id: string; isResolved: boolean } } }>(`mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`, { threadId }, writeIdentity);
    return { content: [{ type: "text", text: `Resolved GitHub review thread ${threadId}.` }], structuredContent: { view: "github-review-thread", ...data.resolveReviewThread.thread }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_run_sandboxed_tests", {
    title: "Run tests in a sandbox",
    description: "Use this when the user explicitly asks to run an allowlisted test command against supplied repository files. The server refuses unless an isolation wrapper is configured; it never runs a shell string.",
    inputSchema: { files: z.array(z.object({ path: z.string().min(1).max(MAX_GITHUB_PATH_CHARS), content: z.string().max(MAX_GITHUB_PATCH_CHARS) })).min(1).max(MAX_GITHUB_PATCH_FILES), command: z.string().min(1).max(64), args: z.array(z.string().max(256)).max(32).default([]), timeoutMs: z.number().int().min(1000).max(120000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI } },
  }, async ({ files, command, args, timeoutMs }): Promise<ToolResult> => {
    const result = await runSandboxedTest({ files, command, args, timeoutMs });
    return { content: [{ type: "text", text: `${result.ok ? "Sandboxed test passed" : "Sandboxed test failed"} with exit code ${result.exitCode ?? "none"} in ${result.durationMs}ms.` }], structuredContent: { view: "sandbox-result", ...result }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "ecg_plan_workflow", {
    title: "Plan a ChatGPT coding workflow",
    description: "Use this when the user wants ECG to choose relevant skills and lay out a safe multi-step coding workflow. Planning does not modify GitHub or execute code.",
    inputSchema: { goal: z.string().min(1).max(4000), language: z.string().max(64).optional(), owner: z.string().max(128).optional(), repo: z.string().max(128).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI } },
  }, async ({ goal, language, owner, repo }): Promise<ToolResult> => {
    const plan = planWorkflow(goal, language);
    const catalog = buildCatalog();
    const available = new Set(catalog.map((item) => item.id));
    const steps = plan.steps.map((step) => ({ ...step, skillIds: step.skillIds.filter((id) => available.has(id)) }));
    return { content: [{ type: "text", text: `Prepared a ${steps.length}-step ECG workflow. Read the selected skills before implementation; write steps remain approval-gated.` }], structuredContent: { view: "ecg-workflow-plan", goal, repository: owner && repo ? `${owner}/${repo}` : null, headline: plan.headline, steps, notes: plan.notes }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_propose_patch", {
    title: "Propose a GitHub patch",
    description: "Use this when the user wants a safe, reviewable patch proposal for a GitHub repository. This tool reads the current files, verifies expected SHAs, and does not modify GitHub.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      baseRef: z.string().max(256).optional().describe("Branch, tag, or commit SHA to base the proposal on."),
      changes: z.array(z.object({ path: z.string().min(1).max(MAX_GITHUB_PATH_CHARS), operation: z.enum(["create", "update", "delete"]), content: z.string().max(MAX_GITHUB_PATCH_CHARS).optional(), expectedSha: z.string().max(128).optional() })).min(1).max(MAX_GITHUB_PATCH_FILES),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Building a safe GitHub patch proposal", "openai/toolInvocation/invoked": "GitHub patch proposal ready" },
  }, async ({ owner, repo, baseRef, changes }): Promise<ToolResult> => {
    const repository = githubRepository(owner, repo);
    const cleanRef = githubRef(baseRef);
    const repositoryInfo = await githubApi<{ default_branch: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`, githubIdentityForTools(identity));
    const effectiveBaseRef = cleanRef || repositoryInfo.default_branch;
    const normalizedChanges = validatePatchChanges(changes);
    const proposalChanges = [];
    for (const change of normalizedChanges) {
      const current = await readGitHubTextFile(repository.owner, repository.repo, change.path, effectiveBaseRef, githubIdentityForTools(identity));
      if (change.operation === "create" && current) throw new Error(`Cannot create ${change.path}: the file already exists.`);
      if (change.operation !== "create" && !current) throw new Error(`Cannot ${change.operation} ${change.path}: the file does not exist at the selected ref.`);
      if (change.expectedSha && current?.sha !== change.expectedSha) throw new Error(`SHA mismatch for ${change.path}; the file changed since it was inspected.`);
      const next = change.operation === "delete" ? "" : change.content ?? "";
      proposalChanges.push({ path: change.path, operation: change.operation, ...(current?.sha ? { expectedSha: current.sha } : {}), ...(change.operation === "delete" ? {} : { content: next }), patch: previewPatch(change.path, change.operation, current?.content ?? "", next) });
    }
    const proposalHashChanges = proposalChanges.map(({ patch: _patch, ...change }) => change);
    const proposalId = crypto.createHash("sha256").update(JSON.stringify({ owner: repository.owner, repo: repository.repo, baseRef: effectiveBaseRef, changes: proposalHashChanges })).digest("hex");
    return { content: [{ type: "text", text: `Prepared patch proposal ${proposalId.slice(0, 12)} for ${repository.owner}/${repository.repo}. No GitHub files were changed.` }], structuredContent: { view: "github-patch-proposal", headline: `Patch proposal: ${repository.owner}/${repository.repo}`, proposalId, owner: repository.owner, repo: repository.repo, baseRef: effectiveBaseRef, changes: proposalChanges }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_create_branch", {
    title: "Create a GitHub branch from a patch",
    description: "Use this only after the user explicitly approves the exact patch proposal. It creates a new non-default branch and applies all approved changes as one atomic commit; it never writes directly to the default branch.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      baseRef: z.string().min(1).max(256).describe("Base branch, tag, or commit SHA."),
      branchName: z.string().min(1).max(256).describe("New branch name; do not use the repository default branch."),
      proposalId: z.string().length(64).describe("SHA-256 proposal ID returned by github_propose_patch."),
      changes: z.array(z.object({ path: z.string().min(1).max(MAX_GITHUB_PATH_CHARS), operation: z.enum(["create", "update", "delete"]), content: z.string().max(MAX_GITHUB_PATCH_CHARS).optional(), expectedSha: z.string().max(128).optional() })).min(1).max(MAX_GITHUB_PATCH_FILES),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Creating an approved GitHub branch", "openai/toolInvocation/invoked": "GitHub branch created" },
  }, async ({ owner, repo, baseRef, branchName, proposalId, changes }): Promise<ToolResult> => {
    const writeIdentity = requireGitHubWriteIdentity(identity);
    const repository = githubRepository(owner, repo);
    assertRepositoryPolicy(repository, "write");
    const cleanBase = githubRef(baseRef);
    const cleanBranch = githubBranchName(branchName);
    const normalizedChanges = validatePatchChanges(changes);
    const proposalIdCheck = crypto.createHash("sha256").update(JSON.stringify({ owner: repository.owner, repo: repository.repo, baseRef: cleanBase, changes: normalizedChanges })).digest("hex");
    if (proposalIdCheck !== proposalId) throw new Error("The supplied changes do not match the approved proposal ID. Re-run github_propose_patch against the current repository state.");
    const repositoryInfo = await githubApi<{ default_branch: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`, writeIdentity);
    if (cleanBranch === repositoryInfo.default_branch) throw new Error("ECG will not write a patch directly to the repository default branch.");
    const base = await githubApi<{ object: { sha: string } }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/ref/heads/${encodeURIComponent(cleanBase)}`, writeIdentity);
    const baseSha = base.object.sha;
    const conflicts: string[] = [];
    for (const change of normalizedChanges) {
      const current = await readGitHubTextFile(repository.owner, repository.repo, change.path, cleanBase, writeIdentity);
      if (change.operation === "create" && current) conflicts.push(`${change.path} already exists`);
      if (change.operation !== "create" && !current) conflicts.push(`${change.path} no longer exists`);
      if (change.operation !== "create" && current && current.sha !== change.expectedSha) conflicts.push(`${change.path} changed since the proposal (expected ${change.expectedSha}, found ${current.sha})`);
    }
    if (conflicts.length > 0) throw new Error(`Patch proposal is stale and was not applied: ${conflicts.join("; ")}`);

    const baseCommit = await githubApi<{ tree: { sha: string } }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/commits/${encodeURIComponent(baseSha)}`, writeIdentity);
    const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }> = [];
    for (const change of normalizedChanges) {
      if (change.operation === "delete") {
        treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = await githubApi<{ sha: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/blobs`, writeIdentity, { method: "POST", body: { content: Buffer.from(change.content ?? "", "utf8").toString("base64"), encoding: "base64" } });
      treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = await githubApi<{ sha: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees`, writeIdentity, { method: "POST", body: { base_tree: baseCommit.tree.sha, tree: treeEntries } });
    const commit = await githubApi<{ sha: string; html_url?: string }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/commits`, writeIdentity, { method: "POST", body: { message: `ECG: apply approved patch ${proposalId.slice(0, 12)}`, tree: tree.sha, parents: [baseSha] } });
    await githubApi(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/refs`, writeIdentity, { method: "POST", body: { ref: `refs/heads/${cleanBranch}`, sha: commit.sha } });
    const applied = normalizedChanges.map((change) => change.path);
    return { content: [{ type: "text", text: `Created branch ${cleanBranch} from ${cleanBase} and applied ${applied.length} approved file change(s) in one atomic commit.` }], structuredContent: { view: "github-branch", headline: `${repository.owner}/${repository.repo}:${cleanBranch}`, owner: repository.owner, repo: repository.repo, branchName: cleanBranch, baseRef: cleanBase, proposalId, commitSha: commit.sha, commitUrl: commit.html_url ?? null, atomic: true, applied }, _meta: { "openai/outputTemplate": WIDGET_URI } };
  });

  registerAppTool(server, "github_create_pull_request", {
    title: "Create a GitHub pull request",
    description: "Use this only after the user explicitly approves the exact source branch, target branch, title, and PR body. It creates a pull request and does not merge it.",
    inputSchema: {
      owner: z.string().min(1).max(128).describe("GitHub owner or organization login."),
      repo: z.string().min(1).max(128).describe("GitHub repository name."),
      head: z.string().min(1).max(256).describe("Existing source branch containing the approved changes."),
      base: z.string().min(1).max(256).describe("Target branch, normally the repository default branch."),
      title: z.string().min(1).max(256).describe("Pull request title."),
      body: z.string().max(16_000).optional().describe("Pull request description."),
      draft: z.boolean().optional().describe("Create as a draft pull request when true."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/toolInvocation/invoking": "Creating an approved GitHub pull request", "openai/toolInvocation/invoked": "GitHub pull request created" },
  }, async ({ owner, repo, head, base, title, body, draft }): Promise<ToolResult> => {
    const writeIdentity = requireGitHubWriteIdentity(identity);
    const repository = githubRepository(owner, repo);
    assertRepositoryPolicy(repository, "write");
    const cleanHead = githubBranchName(head);
    const cleanBase = githubBranchName(base);
    const pull = await githubApi<{ number: number; html_url: string; title: string; state: string; draft: boolean; head: { ref: string }; base: { ref: string } }>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`, writeIdentity, { method: "POST", body: { title: title.trim(), head: cleanHead, base: cleanBase, body: body?.trim() ?? "", draft: Boolean(draft) } });
    return { content: [{ type: "text", text: `Created GitHub pull request #${pull.number}: ${pull.title}. It was not merged.` }], structuredContent: { view: "github-pull-request", headline: `PR #${pull.number}: ${pull.title}`, number: pull.number, url: pull.html_url, state: pull.state, draft: pull.draft, head: pull.head.ref, base: pull.base.ref }, _meta: { "openai/outputTemplate": WIDGET_URI } };
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
  const normalized = new Set(requested.filter((item) => OAUTH_SCOPES.includes(item as typeof OAUTH_SCOPES[number])));
  return Array.from(normalized).join(" ") || OAUTH_SCOPES[0];
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
    github.searchParams.set("scope", "read:user user:email public_repo");
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
      const identity = { ...pending.identity, ecgScope: pending.scope };
      oauthAccessTokens.set(accessToken, { identity, scope: pending.scope, resource, expiresAt: Date.now() + OAUTH_TOKEN_TTL_MS });
      oauthRefreshTokens.set(refreshToken, { identity, scope: pending.scope, resource, expiresAt: Date.now() + OAUTH_REFRESH_TTL_MS });
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
