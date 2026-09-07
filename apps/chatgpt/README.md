# Everything ChatGPT app

This is the ChatGPT Apps SDK surface for ECG. It exposes the ECG catalog through a remote MCP server and renders search/fetch results in a small ChatGPT widget.

## App shape

This is an interactive-decoupled app: the MCP server owns the catalog and the widget renders structured results. The app is read-only in this first implementation; it does not edit repositories, execute shell commands, or transmit project files.

## Tools

- `ecg_overview` — explain the ECG harness and show the catalog counts.
- `search` — search skills, agents, commands, contexts, rules, and guides.
- `fetch` — read one catalog item returned by `search`.

The server only exposes a bounded set of ECG documentation paths. It rejects traversal attempts and truncates returned files to keep tool responses manageable.

The service applies request-size and per-client rate limits, structured request logs, security headers, and an allowlist-based CORS policy. Setting `ECG_ACCESS_TOKEN` enables an optional bearer-token gate for private deployments; the eventual ChatGPT integration should replace that single-token mode with OAuth and per-user authorization.

## Local development

```bash
npm install
npm run check
npm run dev
```

The MCP endpoint is `http://localhost:8787/mcp`. To test from ChatGPT, expose it through a public HTTPS tunnel, add the resulting `/mcp` URL as a developer-mode app under ChatGPT settings, then refresh the app after changing tools or widget metadata.

Run the deployed smoke test from the repository root with `npm run app:test`. Set `ECG_MCP_URL` to test another deployment.

This is a private developer-mode integration at this stage, not a public directory submission.

## Render deployment

The repository includes a root `render.yaml` for a free Render web service. Create a new Blueprint from the GitHub repository and select the `everything-chatgpt` service. Render installs the app dependencies, uses its assigned `PORT`, and health-checks `/`.

The free service may sleep after inactivity, so the first request after a quiet period can be slow. It is suitable for personal testing; production use should add authentication and a persistent deployment.
