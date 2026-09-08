const baseUrl = (process.env.ECG_MCP_URL ?? "https://everything-chatgpt.onrender.com/mcp").replace(/\/$/, "");
const bearerToken = process.env.ECG_MCP_BEARER_TOKEN?.trim();

async function call(payload) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  const response = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (!challenge.includes("oauth-protected-resource")) throw new Error("unauthenticated MCP response did not advertise OAuth metadata");
    return null;
  }
  if (!response.ok) throw new Error(`${payload.method} returned HTTP ${response.status}`);
  return response.json();
}

const health = await fetch(baseUrl.replace(/\/mcp$/, "/healthz"));
if (!health.ok) throw new Error(`health check returned HTTP ${health.status}`);
const healthBody = await health.json();
if (healthBody.status !== "ok") throw new Error("health check did not report ok");

const resourceMetadata = await fetch(baseUrl.replace(/\/mcp$/, "/.well-known/oauth-protected-resource"));
if (!resourceMetadata.ok) throw new Error(`OAuth protected-resource metadata returned HTTP ${resourceMetadata.status}`);
const resourceMetadataBody = await resourceMetadata.json();
if (!Array.isArray(resourceMetadataBody.authorization_servers)) throw new Error("OAuth metadata is missing authorization_servers");

const initialized = await call({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ecg-smoke-test", version: "1.0.0" } },
});
if (!initialized) {
  console.log(JSON.stringify({ ok: true, baseUrl, protected: true, message: "MCP correctly requires OAuth before tool access." }));
  process.exit(0);
}
if (initialized.result?.serverInfo?.name !== "everything-chatgpt") throw new Error("unexpected MCP server identity");

const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name);
for (const expected of ["ecg_overview", "search", "fetch", "github_search_repositories", "github_get_repository", "github_list_tree", "github_read_file", "github_list_commits", "github_compare_commits", "github_search_code", "github_propose_patch", "github_create_branch", "github_create_pull_request"]) {
  if (!toolNames.includes(expected)) throw new Error(`missing tool: ${expected}`);
}

const resources = await call({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
const resourceUris = (resources.result?.resources ?? []).map((resource) => resource.uri);
if (!resourceUris.includes("ui://widget/ecg-catalog-v1.html")) throw new Error("missing ECG widget resource");

console.log(JSON.stringify({ ok: true, baseUrl, server: initialized.result.serverInfo, tools: toolNames, resources: resourceUris }));
