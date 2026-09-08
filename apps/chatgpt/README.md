# Everything ChatGPT

Everything ChatGPT is the ChatGPT/Codex-first port of Everything Claude Code's reusable catalog. In the ChatGPT app it provides a small, read-only MCP surface for finding and reading skills, agents, commands, rules, contexts, and guides.

## What ECG does

- `ecg_overview` explains the catalog.
- `search` finds relevant catalog items.
- `fetch` reads a selected item.
- `ecg_plan_workflow` recommends an ordered set of skills for a coding task.
- The widget renders catalog results inside ChatGPT.

ECG does not duplicate GitHub. Repository search, file inspection, history, diffs, editing, test execution, branches, pull requests, review comments, and conflict resolution are handled by the native GitHub app/connector and Codex. This avoids a second credential store and keeps write permissions in the platform that already owns the repository workflow.

## Safe workflow policy

1. Ask ECG to plan the task and select relevant skills.
2. Read the selected skill with `fetch`.
3. Use the native GitHub app and Codex to inspect or change the repository.
4. Run tests in Codex's approved environment.
5. Open pull requests ready for review.
6. Never merge without explicit user confirmation.

The server has no GitHub OAuth flow, GitHub token storage, repository write tools, or command-execution endpoint. An optional `ECG_ACCESS_TOKEN` can protect the catalog endpoint when it is hosted privately.

## Local development

```bash
npm install
npm run check --prefix apps/chatgpt
npm run dev --prefix apps/chatgpt
```

The MCP endpoint is `http://localhost:8787/mcp`; health is `http://localhost:8787/healthz`.

```bash
ECG_MCP_URL=http://127.0.0.1:8787/mcp node scripts/test-chatgpt-mcp.mjs
ECG_MCP_URL=http://127.0.0.1:8787/mcp node scripts/test-chatgpt-github.mjs
```

The second script retains its historical filename for compatibility, but it now tests the ECG workflow planner only; it does not call GitHub.

## ChatGPT Developer Mode

Expose the server through a stable HTTPS host or tunnel, add the `/mcp` URL as a developer app, then refresh the app after server or tool metadata changes. For personal use, keep the app private and use the native GitHub plugin for repository access.

## Production notes

Use a stable HTTPS deployment, environment-managed secrets, request logs, health checks, rate limiting, and a monitored deployment. ECG's catalog is intentionally stateless and read-only, so it does not need encrypted GitHub sessions or a custom execution sandbox.
