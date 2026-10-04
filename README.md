# OMH Models, Permissions, and Execution

An installable Cordis bundle for automatic model-catalog synchronization, searchable composer and subagent model pickers, persistent Auto-review defaults, and GPU access in confined Linux commands. Covers checklist **OMH-40–44 and OMH-55**.

Targets the OMH/DeepSeek Harness **0.2.1-alpha.1 Web profile**, Node 22.19+ or 24+. Source and built JavaScript are included. The bundle mounts replacement owners through Cordis and leaves the installed harness source and packages intact.

## Install

```sh
node scripts/install.mjs --profile /absolute/path/to/profile --runtime /absolute/path/to/deepseek-harness-latest
```

An existing profile must contain the compatible Web bundle; a missing profile is initialized with the standard Web bundles. Restart its host after installation. `--dry-run` checks the installation plan; `--uninstall` removes this bundle. Keep this checkout and the supplied runtime available because installation links compatible runtime dependencies.

The bundle replaces `ui-model-selection`, `ui-settings-plugins`, `ui-settings-subagent`, `permission`, and `sandbox`, and adds `omh-models-model-sync`. The `omh-models-rpc-schemas` row registers the replacement permission owner's generated host schemas. Apply custom permission or sandbox settings to the new `omh-models-permission` and `omh-models-sandbox` ids. The included permission table matches the stock Web composition. Remove any preexisting model-sync row before activating the equivalent here.

## Features and configuration

| Checklist | Behavior |
| --- | --- |
| OMH-40 | Reconcile model ids, display labels, capabilities, and delegation allowlists from a bridge's OpenAI-shaped `/v1/models` response. |
| OMH-41 | Search composer model names, ids, and provider names with keyboard navigation. |
| OMH-42 | Filter the subagent allowlist while retaining checked and saved-but-unavailable routes for removal. |
| OMH-43 | Store `auto` as the default permission preset and resolve its live admission gate for new sessions. |
| OMH-44 | Grant existing NVIDIA/DRM compute devices inside bubblewrap/Landlock confinement. |
| OMH-55 | Set up Kimi, DeepSeek, ChatGPT, and Cursor backends with private credentials and an optional isolated gateway companion. |

Model sync defaults to `http://127.0.0.1:10100/v1/models` and the `opencodex`/`cursor` provider routes. Configure `bridge`, `routes`, `credentialRef`, `refreshIntervalMs`, `minIntervalMs`, and `stuckAfterMs` on `omh-models-model-sync` for your deployment. The supplied catalog adapter recognizes bare/OpenAI ids as `opencodex` and `cursor/` ids as `cursor`; other provider naming schemes require an adapter change. An unavailable bridge leaves configured catalogs intact and emits a warning. Endpoint credentials are resolved on the host and are never bundled.

## Kimi, DeepSeek, ChatGPT, and Cursor backends

The same Models category includes portable provider setup and a read-only doctor. It uses DSH's existing adapters and credential store. The optional [OpenCodex companion](companions/opencodex/README.md) supplies the ChatGPT/Cursor gateway, account login, and its live model catalog in a separate private data directory.

| Backend | Route and authentication | Model catalog |
| --- | --- | --- |
| DeepSeek | Stock `deepseek-official` adapter with your `DEEPSEEK_API_KEY`, or DSH's existing DeepSeek account login | Installed DSH catalog |
| Kimi | Native `kimi-coding`; your `KIMI_API_KEY` through Models settings/environment, or an existing DSH Kimi OAuth credential | Installed SDK catalog |
| ChatGPT gateway | `opencodex`; your account login in the companion, plus the private gateway bearer credential | Automatically reconciled from the gateway |
| ChatGPT native | Optional `openai-codex`; an existing DSH OAuth credential | Installed SDK catalog |
| Cursor | `cursor`; your account connected to the companion, plus the private gateway bearer credential | Automatically reconciled from the gateway |

For a fresh installation, install the category bundle, configure the companion with your own accounts, and stop the DSH host before applying the provider plan:

```sh
node scripts/backend-setup.mjs --profile /path/to/home/profiles/web --runtime /path/to/deepseek-harness --chatgpt gateway --dry-run
node scripts/backend-setup.mjs --profile /path/to/home/profiles/web --runtime /path/to/deepseek-harness --chatgpt gateway
```

The default setup enables Kimi and the ChatGPT/Cursor gateway routes; DeepSeek is already provided by the Web bundle. New gateway routes use `http://127.0.0.1:10100/v1`, the credential reference `OMH_GATEWAY_API_KEY`, and empty model lists until the first successful catalog sync. `--gateway-url` and `--gateway-key-ref` customize these defaults. For a fresh gateway setup, the command also points model-sync at the selected gateway's `/models` endpoint with the same credential reference. Store the gateway token privately through DSH Models settings or the companion's documented credential setup; the command accepts reference names only, never tokens. Kimi's empty native profile retains the adapter's existing OAuth/environment behavior.

Use `--chatgpt native` for an existing DSH ChatGPT OAuth credential, or `--chatgpt both` to expose both routes with separate labels. This command does not initiate a native OAuth login. DSH 0.2.1 exposes its generic login flows on the host but has no generic browser sign-in controller for these providers; the companion gateway is the documented fresh-user ChatGPT login path.

Setup adds absent providers only. Existing endpoints, headers, credential references, model lists, custom providers such as GLM, and explicit model-sync settings are preserved. It also reads a pending legacy `home/settings.yaml` so copied user settings are not shadowed during migration. Running it again is a no-op. Pass `--home /path/to/home` when the profile is outside the usual `home/profiles/<name>` layout. Existing custom gateway configurations retain their existing sync source; changing their endpoint is an explicit Models/settings operation. Setup reports whether sync came from a bundle default or a user override, and prints a notice when a preserved source or route filter does not cover newly added gateways.

After restarting DSH, inspect the setup without exposing credentials:

```sh
node scripts/backend-doctor.mjs --profile /path/to/home/profiles/web --runtime /path/to/deepseek-harness --home /path/to/home
node scripts/backend-doctor.mjs --profile /path/to/home/profiles/web --runtime /path/to/deepseek-harness --home /path/to/home --probe
```

The doctor reports route and credential-presence facts. `--probe` additionally performs authenticated `GET /models` calls for configured gateways and prints status/counts only; it never sends a completion or writes settings. Its credential check inspects the selected home and current environment; other runtime `.env` fallbacks may still supply credentials. Automatic online roster updates apply to the gateway routes. Native Kimi, DeepSeek, and ChatGPT catalogs track the installed DSH/SDK release.

Persisting Auto does not install the Auto-review integration or choose Auto on the user's behalf. Install the harness's compatible Auto-review integration, then select Auto as the saved permission default in settings. A stored Auto default falls back to the composition default with a warning when its integration is absent.

GPU access is enabled on `omh-models-sandbox` through `gpuDevices: true`; set it to `false` to withhold device access. The grant exposes GPU device ioctls and memory while preserving filesystem confinement. It applies to existing NVIDIA compute nodes and DRM render nodes on Linux; macOS and Windows behavior is unchanged.

## Development and verification

`npm test` checks the package. `node --test plugins/model-sync/tests/*.test.js` covers catalog reconciliation. Set `DSH_RUNTIME=/path/to/deepseek-harness` when running `node --test scripts/backend.test.mjs` to include real YAML/profile command tests; the remaining backend tests run without a runtime. `node scripts/build-client.mjs --runtime /path/to/deepseek-harness-latest` rebuilds the copied picker UI with the compatible harness toolchain. GPU hardware, the bridge endpoint, and Auto's reviewer are external runtime dependencies; package checks do not contact them.

`UPSTREAM.json` records the original API and source baseline. The upstream plugin names inside `plugins/` preserve browser and service identity; category-owned Cordis row ids select these implementations.

## Latest DSH compatibility

Version 0.2.0 targets upstream commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (DSH 0.2.1-alpha.1). Picker, settings, permissions, and sandbox owners were rebased onto that release before applying OMH additions; generated host schemas and browser artifacts match it. This version requires the new runtime and is not compatible with the original 0.1.6-alpha.1 installation. See [CHANGELOG.md](CHANGELOG.md).
