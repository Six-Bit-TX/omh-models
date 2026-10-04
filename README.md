# OMH Models, Permissions, and Execution

An installable Cordis bundle for automatic model-catalog synchronization, searchable composer and subagent model pickers, persistent Auto-review defaults, and GPU access in confined Linux commands. Covers checklist **OMH-40–44**.

Targets the OMH/DeepSeek Harness **0.1.6-alpha.1 Web profile**, Node 22.19+ or 24+. Source and built JavaScript are included. The bundle mounts replacement owners through Cordis and leaves the installed harness source and packages intact.

## Install

```sh
node scripts/install.mjs --profile /absolute/path/to/profile --runtime /absolute/path/to/omchor-harness
```

An existing profile must contain the compatible Web bundle; a missing profile is initialized with the standard Web bundles. Restart its host after installation. `--dry-run` checks the installation plan; `--uninstall` removes this bundle. Keep this checkout and the supplied runtime available because installation links compatible runtime dependencies.

The bundle replaces `ui-model-selection`, `ui-settings-plugins`, `permission`, and `sandbox`, and adds `omh-models-model-sync`. The `omh-models-rpc-schemas` row registers the replacement permission owner's generated host schemas. Apply custom permission or sandbox settings to the new `omh-models-permission` and `omh-models-sandbox` ids. The included permission table matches the stock Web composition. Remove any preexisting model-sync row before activating the equivalent here.

## Features and configuration

| Checklist | Behavior |
| --- | --- |
| OMH-40 | Reconcile model ids, display labels, capabilities, and delegation allowlists from a bridge's OpenAI-shaped `/v1/models` response. |
| OMH-41 | Search composer model names, ids, and provider names with keyboard navigation. |
| OMH-42 | Filter the subagent allowlist while retaining checked and saved-but-unavailable routes for removal. |
| OMH-43 | Store `auto` as the default permission preset and resolve its live admission gate for new sessions. |
| OMH-44 | Grant existing NVIDIA/DRM compute devices inside bubblewrap/Landlock confinement. |

Model sync defaults to `http://127.0.0.1:10100/v1/models` and the `opencodex`/`cursor` provider routes. Configure `bridge`, `routes`, `minIntervalMs`, and `stuckAfterMs` on `omh-models-model-sync` for your deployment. The supplied catalog adapter recognizes bare/OpenAI ids as `opencodex` and `cursor/` ids as `cursor`; other provider naming schemes require an adapter change. An unavailable bridge leaves configured catalogs intact and emits a warning. No endpoint credentials or provider settings are bundled.

Persisting Auto does not install the Auto-review integration or choose Auto on the user's behalf. Install the harness's compatible Auto-review integration, then select Auto as the saved permission default in settings. A stored Auto default falls back to the composition default with a warning when its integration is absent.

GPU access is enabled on `omh-models-sandbox` through `gpuDevices: true`; set it to `false` to withhold device access. The grant exposes GPU device ioctls and memory while preserving filesystem confinement. It applies to existing NVIDIA compute nodes and DRM render nodes on Linux; macOS and Windows behavior is unchanged.

## Development and verification

`npm test` checks the package. `node --test plugins/model-sync/tests/*.test.js` covers catalog reconciliation. `node scripts/build-client.mjs --runtime /path/to/omchor-harness` rebuilds the copied picker UI with the compatible harness toolchain. GPU hardware, the bridge endpoint, and Auto's reviewer are external runtime dependencies; package checks do not contact them.

`UPSTREAM.json` records the original API and source baseline. The upstream plugin names inside `plugins/` preserve browser and service identity; category-owned Cordis row ids select these implementations.
