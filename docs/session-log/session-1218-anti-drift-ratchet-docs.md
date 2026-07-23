## Session 1218 — Anti-drift conformance-coverage ratchet + testing invariants (#3083, #3086) (2026-07-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-23 |
| **Branch** | `feat/3083-anti-drift-ratchet-docs` |
| **Items closed** | #3083, #3086 |
| **Outcome** | **SHIPPED** — behavioral-coverage ratchet (green now, non-vacuous) + four anti-drift AGENTS.md invariants |

### Problem

The JS Tauri mock (`src/lib/tauri-mock/`) is a hand-maintained second implementation of the Rust backend that silently drifts. The #763 conformance harness catches behavioral drift for the ops it covers, but nothing forced NEW mutating commands to acquire a fixture, and `handlers-drift.test.ts` only checks command-NAME coverage. Recent escapes: create_block page_id, purge_block cascade, reserved-key property routing, the tag-space bug (mock modeled retired `block_properties(key='space')`).

### #3083 — the ratchet

Added `src/lib/tauri-mock/__tests__/conformance-coverage.test.ts`. It does NOT re-run the replay (that is `conformance.test.ts`); it asserts the coverage SURFACE has not regressed:

1. **Mutating-command → fixture coverage.** Commands are extracted from `bindings.ts` (same regex as the drift test) and classified: read-only by query-verb prefix (`get_`/`list_`/`query_`/… + a small `READ_ONLY_EXACT` set), everything else is a MUTATING candidate. Each mutating command must EITHER be driven by ≥1 conformance fixture (a conformance op IS the IPC command name, so `fixtureOpCommands` is computed from the fixtures — no hardcoded op list) OR have a reasoned entry in `NO_FIXTURE_ALLOWLIST` (52 entries: batch variants, undo/redo, drafts, attachments, spaces/aliases/property-defs, sync/peer, telemetry/MCP toggles). On the current tree: 141 commands → 66 mutating → 14 fixture-covered + 52 allowlisted → 0 uncovered. A hygiene test fails if an allowlist entry goes stale, is read-only, or later gains a fixture.
2. **Required-scenario manifest.** `REQUIRED_SCENARIOS` lists `(op, scenario)` tuples; each must be pinned by a fixture that declares the scenario in an additive top-level `scenarios` string array AND drives the op. 12 active tuples are green now (tagged 10 fixtures). Four not-yet-covered scenarios are COMMENTED OUT, one line each, to enable by uncommenting when their fixtures land: `purge_block/subtree-with-satellites` and `create_block/tag-space-scope` (#3079), `set_property/reserved-key-routes-to-column` and `delete_property/reserved-key-clears-column` (#3081).

The `scenarios` tags are additive and inert to the replay — verified the Rust runner parses fixtures as generic `serde_json::Value` and CONFORMANCE_UPDATE only replaces `["expected"]`, so the tag survives update mode; `conformance.test.ts` still passes. Failure messages name the uncovered command/scenario and the exact fix (add a fixture with `CONFORMANCE_UPDATE=1 …conformance_fixtures_match_backend`, or an allowlist entry). Non-vacuity proven: temporarily appending a fake `frobnicate_widget` invoke to `bindings.ts` made the ratchet fail with `["frobnicate_widget"]`; restored.

### #3086 — docs

Encoded four anti-drift invariants:

- `src/__tests__/AGENTS.md`, `src/stores/__tests__/AGENTS.md`, `src/components/__tests__/AGENTS.md` — **assert durable, re-queried effect, never call-shape**, with the tag-space bug as the cautionary example.
- `e2e/AGENTS.md` — **the mock is a contract**: state-mutating handlers pinned by conformance fixtures (ratchet), the conformance authoring workflow, and an honest note that the real-Tauri WDIO smoke is scoped-not-shipped (#155, session-949) — Playwright green does not prove backend parity.
- `src-tauri/migrations/AGENTS.md` — **migration → mock rule**: a migration touching a mock-referenced table/column updates the mock + fixture in the same PR (#3084).
- Root `AGENTS.md` § **Testing invariants (anti-drift)** — pointer section linking the above + the conformance harness, cross-linking the #891 production-path-not-fallback lesson.

### Verification

`npx vitest run src/lib/tauri-mock` (17 files / 203 tests green incl. the new guard), `npx tsc -b` (exit 0), `npx oxlint` on changed files (exit 0), `oxfmt --write` on the new test file. Did NOT modify any fixture `seed`/`ops`/`expected`.
