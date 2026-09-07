const baseUrl = (process.env.ECG_MCP_URL ?? "http://127.0.0.1:8787/mcp").replace(/\/$/, "");
const bearerToken = process.env.ECG_MCP_BEARER_TOKEN?.trim();

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

let id = 0;
async function call(method, params) {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "ecg-github-smoke-test", version: "1.0.0" },
});

const owner = process.env.ECG_TEST_GITHUB_OWNER ?? "battlesbudz";
const repo = process.env.ECG_TEST_GITHUB_REPO ?? "everything-chatgpt";
const repository = await call("tools/call", { name: "github_get_repository", arguments: { owner, repo } });
if (repository.structuredContent?.repository?.fullName !== `${owner}/${repo}`) throw new Error("repository metadata did not match the requested repository");

const tree = await call("tools/call", { name: "github_list_tree", arguments: { owner, repo, path: "apps/chatgpt" } });
if (!tree.structuredContent?.entries?.some((entry) => entry.path === "apps/chatgpt/package.json")) throw new Error("repository tree did not include the expected app package");

const file = await call("tools/call", { name: "github_read_file", arguments: { owner, repo, path: "apps/chatgpt/package.json" } });
if (!file.structuredContent?.content?.includes('"name": "everything-chatgpt"')) throw new Error("repository file contents were not returned");

const search = await call("tools/call", { name: "github_search_repositories", arguments: { query: `${owner}/${repo}` } });
if (!Array.isArray(search.structuredContent?.results)) throw new Error("repository search did not return results");

console.log(JSON.stringify({ ok: true, repository: repository.structuredContent.repository.fullName, treeEntries: tree.structuredContent.entries.length, fileChars: file.structuredContent.content.length, searchResults: search.structuredContent.results.length }));
