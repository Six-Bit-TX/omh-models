# Automatic model catalogue refresh

This host plugin refreshes the existing `opencodex` and `cursor` provider model lists from an OpenAI-compatible gateway's `/v1/models`. It runs after application readiness, every five minutes, and when a new Session starts outside the debounce window. The Models picker updates through DSH settings without a restart. Native DeepSeek, Kimi, and native ChatGPT OAuth routes retain the installed SDK catalogue; this plugin does not invent an online discovery endpoint for them.

Only each managed provider's `models` array changes. Provider URLs, protocols, credentials, headers, and other connection settings remain intact, and existing model labels survive refreshes. Advertised capabilities replace capabilities inside managed model lists. Empty catalogues, missing provider families, HTTP failures, malformed responses, and unavailable credentials preserve existing lists. Successful refreshes mirror configured delegation entries in `subagent-model-selection-settings`; other providers' entries remain intact. Conflicting settings writes are replanned against the current revision.

| Option | Default | Meaning |
| --- | --- | --- |
| `bridge` | `http://127.0.0.1:10100/v1/models` | Absolute HTTP(S) catalogue URL without user information, query, or fragment. |
| `routes` | `[opencodex, cursor]` | Nonempty unique subset of these gateway provider routes. |
| `credentialRef` | omitted | Credential-reference name resolved by DSH on every request and sent as a Bearer token. |
| `refreshIntervalMs` | `300000` | Recurring refresh interval; `0` disables recurring polling. |
| `minIntervalMs` | `300000` | Debounce for new-Session triggers; periodic refresh uses its own interval. |
| `fetchTimeoutMs` | `10000` | Deadline covering the request and response body. |
| `stuckAfterMs` | `120000` | Release an unsettled refresh so a later trigger can retry. |

When `credentialRef` is omitted, the plugin can reuse an existing managed provider's headers or `apiKeyEnv` reference only if its `baseURL` plus `/models` is exactly the configured catalogue URL. Credentials remain on the host and never enter model-list settings or logs. Requests reject redirects to prevent forwarding custom headers to another endpoint. A missing explicit credential prevents the request rather than falling back to an unauthenticated request.

The plugin requires `settings`, `appReady`, and `credentials`. Disposal removes the readiness subscription, cancels polling and requests, and prevents late results from issuing more settings writes. A settings transaction already accepted by the settings service remains owned by that service.

Run `node --test tests/*.test.js` from this directory. Tests use synthetic catalogues and credentials and never send model inference requests.

For the real profile regression, run `DSH_RUNTIME=/absolute/path/to/built/deepseek-harness node --test tests/profile.e2e.mjs`. This separate, environment-gated test starts an isolated DSH Web profile and a local authenticated catalogue, verifies startup and periodic updates through the actual settings service, and removes its temporary home. It is excluded from the default unit-test glob.
