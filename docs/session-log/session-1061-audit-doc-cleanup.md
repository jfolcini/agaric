# Session 1061 — audit doc-cleanup batch (GCal purge + stale-doc fixes)

2026-06-16. From the 2026-06 round-2 Opus audits (documentation/dx). `/loop /batch-issues` run.
One PR bundling the small, evidence-backed pure-docs corrections. Root `AGENTS.md` deliberately
untouched (approval-gated).

## Fully fixed (closeable)
- **#1330** — purged all *live* Google Calendar references (removed in `fd1c28a3`) across
  `operations.md`, `ARCHITECTURE.md` (map row + backend-code list), `frontend.md` (GcalReauthBanner
  mount, keychain/OAuth bullet, SpaceScope note), `UI-MAP.md`, `tooling.md` (deleted `Gcal` AppError
  variant), and `features/{spaces,sync,views}.md`. Verified `GcalReauthBanner` + `Gcal` variant no
  longer exist in code. Remaining grep hits are dated/historical docs only.
- **#1331** — `benches/AGENTS.md` "legacy TEXT" cross-ref corrected.
- **#1332** — `migrations/AGENTS.md:67` stale "#109 Phase 2 pending" → completed (0077/0079/0080/0081/0082 INTEGER epoch-ms; `now_rfc3339()` non-DB only).
- **#1334** — `migrations/AGENTS.md` "Verifying" filter `cargo nextest run migration_tests` (matched **0** tests) → `cargo nextest run -E 'test(/_(376|606|708)$/)'` (verified selects the real per-migration round-trip tests); documents the `_<issue>` suffix convention.
- **#1335** — `FEATURE-MAP.md` drafts table `drafts` → `block_drafts`.
- **#1337** — `useSyncTrigger.ts`: doc-comment for the run-generation-counter pattern (mutable ref by design). Comment-only.
- **#1338** — `useDebouncedCallback.ts`: doc-comment for the intentional empty-deps + ref-refresh contract. Comment-only.

## Partially fixed (docs-only parts; issues stay open for the root-AGENTS.md remainder)
- **#1350** — `pickers-and-slash.md` "how to add a slash command" repointed at the real catalog `src/lib/slash-commands.ts`; added a code-review-graph MCP install subsection to `BUILD.md`. (Root AGENTS.md "soften ALWAYS" skipped.)
- **#1351** — `BUILD.md:166` `SKIP_CI_VERIFY` corrected to the working reason-string form; `prek.toml` vitest comment de-staled (no FALLBACK in `test-related-ts.sh`). (Root AGENTS.md sqlx-`-- --tests` / SKIP_CI_VERIFY:269 / SESSION-LOG-row parts skipped.)

## Verification
`tsc --noEmit` clean (the two `.ts` comment edits parse). All added file:line citations verified to
resolve. Built by one agent; constraints (no root AGENTS.md, no broad formatters, no git) honored.
