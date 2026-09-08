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

const commits = await call("tools/call", { name: "github_list_commits", arguments: { owner, repo, limit: 3 } });
if (!Array.isArray(commits.structuredContent?.results) || commits.structuredContent.results.length === 0) throw new Error("commit history did not return results");

const comparison = await call("tools/call", { name: "github_compare_commits", arguments: { owner, repo, base: "main", head: "main" } });
if (comparison.structuredContent?.status !== "identical") throw new Error("same-ref comparison was not identical");

const codeSearch = await call("tools/call", { name: "github_search_code", arguments: { owner, repo, query: "github_read_file" } });
if (!Array.isArray(codeSearch.structuredContent?.results) && !codeSearch.isError) throw new Error("code search returned neither results nor a clear authorization error");

const proposal = await call("tools/call", {
  name: "github_propose_patch",
  arguments: { owner, repo, baseRef: "main", changes: [{ path: "apps/chatgpt/ecg-smoke-fixture.txt", operation: "create", content: "ECG proposal fixture\n" }] },
});
if (!proposal.structuredContent?.proposalId || proposal.structuredContent.changes?.[0]?.operation !== "create") throw new Error("patch proposal did not return a proposal ID and change preview");

const writeAttempt = await call("tools/call", {
  name: "github_create_branch",
  arguments: { owner, repo, baseRef: "main", branchName: "ecg/test-unauthorized", proposalId: proposal.structuredContent.proposalId, changes: [{ path: "apps/chatgpt/ecg-smoke-fixture.txt", operation: "create", content: "ECG proposal fixture\n" }] },
});
if (!writeAttempt.isError) throw new Error("unauthenticated local server unexpectedly allowed branch creation");

console.log(JSON.stringify({ ok: true, repository: repository.structuredContent.repository.fullName, treeEntries: tree.structuredContent.entries.length, fileChars: file.structuredContent.content.length, searchResults: search.structuredContent.results.length, commits: commits.structuredContent.results.length, codeResults: codeSearch.structuredContent?.results?.length ?? 0, codeSearchRequiresAuth: Boolean(codeSearch.isError), proposalId: proposal.structuredContent.proposalId, writeBlocked: true }));
