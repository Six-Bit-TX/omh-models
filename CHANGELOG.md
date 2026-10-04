# Changelog

## 0.2.0 — 2026-10-04

Requires **DSH 0.2.1-alpha.1**. The original 0.1.6-alpha.1 runtime is no longer a compatible target for this version.

- Package reusable Kimi, DeepSeek, ChatGPT, and Cursor backend setup and a read-only doctor. Preserve existing provider settings and keep credentials in the user's private store.
- Add an optional pinned OpenCodex 2.68.0 companion for Cursor and ChatGPT, with isolated account state and client integrations disabled.
- Refresh gateway catalogs periodically and after startup/session creation; authenticate catalog requests through private credential references or matching existing provider settings.
- Use the current DSH settings API and subagent namespace; retain the last usable catalog on failures and stop refresh work during plugin disposal.
- Rebase searchable model/subagent selectors, settings, permission persistence, sandbox support, and generated artifacts onto the current runtime.

Native Kimi, DeepSeek, and ChatGPT model catalogs follow the installed DSH/SDK version. Online catalog reconciliation applies to the ChatGPT/Cursor gateway routes.
