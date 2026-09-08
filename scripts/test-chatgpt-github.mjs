const baseUrl = (process.env.ECG_MCP_URL ?? "http://127.0.0.1:8787/mcp").replace(/\/$/, "");
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let id = 0;
async function call(method, params) {
  const response = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json(); if (payload.error) throw new Error(`${method} failed: ${JSON.stringify(payload.error)}`); return payload.result;
}
await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "ecg-workflow-smoke-test", version: "1.0.0" },
});
const workflow = await call("tools/call", { name: "ecg_plan_workflow", arguments: { goal: "Review and test a pull request safely", language: "TypeScript" } });
if (!Array.isArray(workflow.structuredContent?.steps) || workflow.structuredContent.steps.length < 3) throw new Error("workflow planner did not return ordered steps");
console.log(JSON.stringify({ ok: true, workflowSteps: workflow.structuredContent.steps.length, delegatedGitHub: true, readyForReviewPolicy: true }));
