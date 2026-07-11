## Session 1149 — BibTeX / CSL-JSON bibliography import (2026-07-11)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-11 (same overnight loop as session 1148, batch 3) |
| **Subagents** | 2 build + 1 review + 1 scout |
| **Items closed** | #1454 tier (a) |
| **Items modified** | — |
| **Tests added** | +15 (frontend) / +34 (backend: 20 parser unit + 14 command) |
| **Files touched** | ~14 |

**Summary:** Issue #1454 tier (a) — import a BibTeX or CSL-JSON export as reference
pages. New pure-parser module `src-tauri/src/bibliography.rs` (hand-rolled BibTeX
*subset* with documented limits, mirroring the repo's deliberate YAML-subset philosophy —
no new dependency; CSL-JSON via the existing serde_json) and `import_bibliography`
command: one reference page per entry titled `{first-author family} {year}` (citation-key
fallback, collision suffix), typed properties (`citation-key`, `authors`, `year` as
number, `doi`, `url`, `journal`, `abstract`, `reference-type`) through idempotent
`create_property_def_inner` + `set_property_in_tx` with user-declaration coercion,
citation-key/DOI dedup via one batched pre-query (re-import idempotent), and chunked
`BEGIN IMMEDIATE` commits every 200 entries per the #662/#2470 hold-time contract.
Frontend: fourth import affordance in Settings → Data (extension-inferred format,
i18n'd toasts, warnings panel, a11y-audited), typed-binding wrapper — which retired the
last raw `invoke()` in `src/lib/tauri.ts`.

**Files touched (this session):**
- `src-tauri/src/bibliography.rs` (new), `src-tauri/src/commands/pages/bibliography.rs` (new), `src-tauri/src/commands/tests/bibliography_cmd_tests.rs` (new), `src-tauri/src/lib.rs`, `src-tauri/src/commands/{mod,pages/mod}.rs`, `src-tauri/src/commands/tests/mod.rs`, `.sqlx/` (3 new)
- `src/components/settings/DataTab.tsx` (+ tests), `src/lib/tauri.ts`, `src/lib/i18n/common.ts`, `src/lib/tauri-mock/handlers.ts` (+ drift test, + `import-bibliography.test.ts`), `src/lib/bindings.ts` (specta regen)
- `docs/features/import-export.md` § Bibliography import, `docs/FEATURE-MAP.md` row

**Verification:** (filled from the review round)
- `cd src-tauri && cargo nextest run` — full suite, counts in PR.
- `npx tsc -b` clean; `npx vitest run` — full suite, counts in PR.
- `cargo clippy --all-targets -- -D warnings` clean.

**Process notes:** The two halves were built by parallel subagents against a fixed IPC
contract; the frontend shipped ahead of the specta regen via a sanctioned raw-invoke
wrapper + `PENDING_BINDINGS` drift-test exemption, then graduated to the typed binding
once the backend's regen landed — the exemption mechanism is now empty but reusable.
Session-wide environment battles (shared cargo target dir across two source universes,
gitignored `dev.db`/`.env` missing in git worktrees, disk allowance) are logged in
session 1148's lessons; the durable fix candidates are in #2535.

**Lessons learned (for future sessions):**
- A git worktree needs the gitignored `src-tauri/dev.db` + `.env` symlinked in before
  any sqlx-macro compile (the `agaric-diagnostics` crate's queries hit this even when
  `.sqlx/` covers the main crate).
- Don't share one `CARGO_TARGET_DIR` between two source trees being built alternately —
  fingerprint thrash doubles artifacts and refills the disk; `CARGO_PROFILE_DEV_DEBUG=0`
  halves artifact size when disk is the constraint.
- Never pipe a background push/build through `tail` — the truncation destroys exactly
  the diagnostics needed when it fails.

**Commit plan:** single commit on `claude/1454-bibtex-import`, pushed, PR opened after
the #2557 chain-bottom merges (session-log numbering depends on that order).
