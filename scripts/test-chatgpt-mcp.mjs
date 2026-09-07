const baseUrl = (process.env.ECG_MCP_URL ?? "https://everything-chatgpt.onrender.com/mcp").replace(/\/$/, "");

async function call(payload) {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${payload.method} returned HTTP ${response.status}`);
  return response.json();
}

const health = await fetch(baseUrl.replace(/\/mcp$/, "/healthz"));
if (!health.ok) throw new Error(`health check returned HTTP ${health.status}`);
const healthBody = await health.json();
if (healthBody.status !== "ok") throw new Error("health check did not report ok");

const initialized = await call({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ecg-smoke-test", version: "1.0.0" } },
});
if (initialized.result?.serverInfo?.name !== "everything-chatgpt") throw new Error("unexpected MCP server identity");

const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name);
for (const expected of ["ecg_overview", "search", "fetch"]) {
  if (!toolNames.includes(expected)) throw new Error(`missing tool: ${expected}`);
}

const resources = await call({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
const resourceUris = (resources.result?.resources ?? []).map((resource) => resource.uri);
if (!resourceUris.includes("ui://widget/ecg-catalog-v1.html")) throw new Error("missing ECG widget resource");

console.log(JSON.stringify({ ok: true, baseUrl, server: initialized.result.serverInfo, tools: toolNames, resources: resourceUris }));
