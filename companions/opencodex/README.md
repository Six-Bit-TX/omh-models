# Optional OpenCodex companion

This companion provides the Cursor and ChatGPT gateway for OMH Models. It pins
`@bitkyc08/opencodex@2.68.0` and its Bun 1.4.0 runtime in `package-lock.json`.
The dependency contains the provider implementations; its MIT license is reproduced
in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). No provider account or credential
is included.

DSH already implements DeepSeek Official, Kimi Coding and OpenAI Codex. Those
native adapters remain the normal routes for DeepSeek, Kimi and ChatGPT. The
companion adds Cursor and an optional ChatGPT account-pool gateway. OMH's live
catalog sync currently updates the gateway's `opencodex` and `cursor` routes;
the native provider catalogs come from the DSH SDK and update with that SDK.

## Reuse an existing bridge

Point the Models backend setup at its `/v1` URL. No companion install, copied
accounts or second service is needed. A read-only health and model-count check is:

```sh
node companions/opencodex/cli.mjs doctor --url http://127.0.0.1:10100/v1
```

If that bridge requires authentication, provide `OMH_GATEWAY_API_KEY` in the
process environment. Doctor prints only health/readiness booleans, a model count
and credential presence; it does not print model names, remote bodies or secrets.
It never sends inference. Existing bridges retain their own authentication policy.

## Install a separate companion

From this directory, with Node 22.19 or newer:

```sh
npm ci
npm run setup
npm start
```

Setup creates `~/.local/share/omh-models/opencodex`, generates two private tokens,
and records configuration without starting a service. Set `OMH_OPENCODEX_HOME`
to a new absolute directory to choose another location. Setup refuses an existing
unowned directory and never imports `~/.opencodex` or `~/.codex`.

The foreground server binds only `127.0.0.1:10100`. If the port is occupied it
refuses to start; it neither stops the other server nor silently changes ports.
Choose another port when creating a new home: `npm run setup -- --port 10101`.
Keep the terminal open while using the companion; Ctrl-C stops it.

Configure DSH's gateway routes with `http://127.0.0.1:10100/v1` and credential
reference `OMH_GATEWAY_API_KEY`. Store the contents of the private file
`<companion-home>/gateway-api-token` in DSH's credential store under that name,
or load it into the environment of the DSH process. Do not paste it into a
profile, source file, command argument, issue or log. The separate
`admin-api-token` is for the companion's login wrapper only.

## Sign in

Run these commands from this directory, using the same `OMH_OPENCODEX_HOME` in
both terminals if customized:

```sh
npm run login -- cursor
npm run login -- chatgpt
# ChatGPT device-code alternative:
npm run login -- chatgpt --device
npm run doctor
```

Cursor opens its standalone browser login and does not require Cursor IDE or
`cursor-agent`. ChatGPT uses a dedicated `omh-chatgpt` pool account and requires
the companion to be running. The wrapper passes an isolated Codex state home;
it does not use the desktop application's existing login. After an offline
Cursor/API-key login, restart with Ctrl-C followed by `npm start` so the running
server adopts the changed credential. Do not follow upstream suggestions to
run global `ocx start`, `ocx sync` or `ocx restart` for this companion.

Optional bridge-specific `kimi`, `kimi-code` and `deepseek` logins are also
accepted by `npm run login -- <provider>`. These are separate from DSH's native
Kimi/DeepSeek credentials; OMH does not automatically add their gateway routes.
Use the native DSH provider setup unless those additional gateway routes are
intentional.

## Isolation and compatibility

The launcher calls OpenCodex's public `startServer` API directly. It never calls
the upstream start, integration, service-install, environment-injection or history
migration commands. The private configuration disables Codex, Grok and Claude
Desktop integrations, auto-start, shim restoration and Cursor native local
execution. Claude Code and its otherwise default-on intercept listener are
explicitly disabled. `OPENCODEX_HOME` and the child process's native Codex home both stay
inside the companion directory.

OpenCodex 2.68.0 normally skips data-plane authentication on loopback. The pinned
wrapper temporarily intercepts its synchronous `Bun.serve` call to wrap the
actual fetch handler, then restores `Bun.serve` in `finally`. Every `/v1/` request,
including catalog, streaming and WebSocket handshakes, needs the gateway token.
The wrapper returns the upstream response unchanged, preserving streaming and
cancellation. Only exact health/readiness GETs and a fixed set of login routes
remain exposed; login routes require the distinct admin token and still pass
through upstream management authentication. GUI, remote workspace control,
system actions and alternate proxy paths are unavailable. Listener/API changes
fail closed rather than starting an unguarded listener.

The bridge readiness check indicates that the isolated server has started; it
does not imply that a provider has been signed in. Model catalog reads may ask
providers for current account capabilities after login. No model generation is
needed for doctor or OMH model synchronization.

## Validation

```sh
npm test
npm run test:bun
```

The first command checks private/idempotent setup, port conflicts, isolated login
arguments, all request gates, untouched streams, cleanup on startup failure and
listener contract checks. The Bun smoke test uses the actual pinned package in a
temporary empty-credential home and checks health, readiness, catalog admission
and streamed chunks on temporary loopback listeners. It forbids external fetches
and sends no inference. No permanent service is started by either test.

`node_modules`, binaries, runtime state, `.env` files and tokens are excluded from
the repository. Updating the pinned backend requires re-running both test suites
and reviewing its startup/authentication contract.
