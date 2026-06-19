# Session 1004 — /batch-issues loop: backend robustness, batch 4 (2026-06-19)

## What happened

Backend Rust batch of the `/loop /batch-issues` run, executed **concurrently with the
frontend batch 5** (main checkout for Rust, worktree for the frontend) per the
wider/overlapping-batches approach agreed mid-run. Three backend robustness findings from
the multi-agent deep review, each on a disjoint file, built by parallel subagents
(capped at 2 concurrent to respect the cargo target lock) and adversarially reviewed.

## Shipped

Single PR `fix/be-robustness-deep-review`:

- **#1607** — the MCP `search` filter-term budget capped element *count* but not
  per-element *byte size*, letting an agent send a few multi-megabyte strings under the
  count cap to force large allocations / expensive glob/regex; added per-string +
  aggregate 256 KiB caps (`MAX_CONTENT_LENGTH`, the same cap `set_property value_text`
  uses against the same column) across every free-text term.
- **#1589** — the deep-link `settings/<tab>` segment was passed through with no length
  bound (unlike the ULID-bounded block/page arms); added `MAX_SETTINGS_TAB_LEN = 64` and
  a `SettingsTabTooLong` rejection.
- **#1590** — the line-based `parse_frontmatter` counted every YAML block-scalar
  (`key: |`/`key: >`) continuation line as `skipped_invalid`, silently dropping the value;
  now tracks block scalars, consuming more-indented continuations as the key's value
  (newline-joined literal / space-joined folded) while keeping genuinely-malformed lines
  counted.

## Review pass

Three adversarial reviewers (one per item). The **#1607 reviewer found a real
HIGH-severity gap the builder missed**: six additional free-text filter vectors
(`block_type_filter`, `state_filter`, `priority_filter`, the excluded variants, and
`DateFilter` strings) flow verbatim into SQL with no enum allowlist, so they bypassed the
byte budget. The reviewer extended the validation to cover them and added 2 regression
tests. #1589 (42 tests) and #1590 (23 tests) reviews were clean.

## Notes

- No new SQL queries → no `.sqlx` regen. `cargo check --all-targets` clean; targeted
  backend suite 77/77 pass.
- Ran in the main checkout while frontend batch 5 ran in a worktree; the two PR pushes
  were serialized (Rust pre-push is heavy — concurrent heavy pushes risk the OOM noted in
  memory).
