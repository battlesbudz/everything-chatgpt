# Everything ChatGPT app

This is the ChatGPT Apps SDK surface for ECG. It exposes the ECG catalog through a remote MCP server and renders search/fetch results in a small ChatGPT widget.

## App shape

This is an interactive-decoupled app: the MCP server owns the catalog and the widget renders structured results. The app is read-only in this first implementation; it does not edit repositories, execute shell commands, or transmit project files.

## Tools

- `ecg_overview` — explain the ECG harness and show the catalog counts.
- `search` — search skills, agents, commands, contexts, rules, and guides.
- `fetch` — read one catalog item returned by `search`.
- `github_search_repositories` — search GitHub repositories using the authenticated user’s GitHub access.
- `github_get_repository` — inspect repository metadata.
- `github_list_tree` — list a bounded repository tree for a branch, tag, or commit.
- `github_read_file` — read a bounded text file without executing it.
- `github_list_commits` — read recent commit history, optionally filtered by path.
- `github_compare_commits` — read a bounded diff between two refs.
- `github_search_code` — search content inside a repository; if GitHub returns an incomplete zero-result response or rejects code search, ECG falls back to a bounded scan of likely text files and reports that fallback in the result.
- `github_propose_patch` — validate expected file SHAs and produce a reviewable patch preview without writing.
- `github_create_branch` — after explicit approval, create a non-default branch and apply the approved patch.
- `github_create_pull_request` — after explicit approval, open a PR without merging it.

The server only exposes a bounded set of ECG documentation paths. It rejects traversal attempts and truncates returned files to keep tool responses manageable.

The service applies request-size and per-client rate limits, structured request logs, security headers, and an allowlist-based CORS policy. `ECG_ACCESS_TOKEN` remains available as a local/private fallback. For ChatGPT, use the OAuth 2.1 mode described below; it provides MCP protected-resource metadata, PKCE, GitHub identity, and short-lived access tokens. The GitHub OAuth flow requests `read:user user:email public_repo`: public-repository branch and PR writes are supported after explicit approval; private-repository access should move to a fine-grained GitHub App before production use.

## OAuth configuration

OAuth is deliberately disabled unless `ECG_AUTH_MODE=oauth` is set. Configure these Render environment variables before enabling it:

```text
ECG_AUTH_MODE=oauth
ECG_RESOURCE_URL=https://everything-chatgpt.onrender.com
ECG_OAUTH_ISSUER=https://everything-chatgpt.onrender.com
ECG_OAUTH_REDIRECT_URIS=https://chatgpt.com/connector_platform_oauth_redirect
GITHUB_OAUTH_CLIENT_ID=<GitHub OAuth app client ID>
GITHUB_OAUTH_CLIENT_SECRET=<stored in Render, never committed>
GITHUB_OAUTH_CALLBACK_URL=https://everything-chatgpt.onrender.com/oauth/github/callback
```

Create a GitHub OAuth App with the callback URL above. The GitHub authorization request includes `read:user user:email public_repo`, which supports public-repository branch and PR writes after explicit user approval. The MCP endpoint advertises `ecg:read` for connector authentication; write authorization is enforced by the presence of the authenticated GitHub token and GitHub’s own repository permissions, not by an invisible custom `ecg:write` connector permission.

The current OAuth transaction and token stores are in memory. That is suitable for the first authenticated read-only test, but production use still requires a durable encrypted session/token store before relying on Render restarts or multiple instances.

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

The repository includes a root `render.yaml` for a free Render web service. Create a new Blueprint from the GitHub repository and select the `everything-chatgpt` service. Render installs the app dependencies, uses its assigned `PORT`, and health-checks `/healthz`.

The free service may sleep after inactivity, so the first request after a quiet period can be slow. It is suitable for personal testing; production use should add authentication and a persistent deployment.
