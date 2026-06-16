# Session 1005 — developer-doc accuracy fixes (#1351)

`/loop /batch-issues` run (2026-06-16), one of a 3-issue parallel batch (#1322 Rust recovery,
#1348 FE gutter, #1351 this).

## Shipped

- **#1351 — four developer-facing doc inaccuracies that actively misdirect.** Each fix was
  verified against its source-of-truth file:
  1. **`AGENTS.md` (×2) — sqlx-regen command.** `cargo sqlx prepare` → `cargo sqlx prepare
     -- --tests`. Without `-- --tests`, test-only queries aren't cached and pre-push fails
     (the verifier runs `cargo sqlx prepare --check -- --tests`,
     `scripts/verify-ci-equivalent.sh:209`). Re-introduced the MAINT-227 footgun otherwise.
  2. **`AGENTS.md` — `SKIP_CI_VERIFY` form.** The script rejects a bare truthy value and
     requires a reason ≥8 chars (`verify-ci-equivalent.sh`); documented the working form
     `SKIP_CI_VERIFY='<reason>' git push`. (`docs/BUILD.md` already documented the correct
     form — left unchanged.)
  3. **`AGENTS.md` — State Files table.** Repointed the deleted root `SESSION-LOG.md` row to
     `docs/session-log/session-NNN-<slug>.md` (see `docs/session-log/README.md`).
  4. **`prek.toml` — vitest-hook comment.** Reworded to describe what `test-related-ts.sh`
     actually does (transitive `vitest related --run` import-graph fan-out, no foundational-
     module fallback — `FALLBACK` lives only in `test-related-rust.sh`).

AGENTS.md edits are approval-gated; the maintainer-authored issue #1351 listing the exact
fixes is the approval. Scoped strictly to the four listed items. Docs/config only — no source.
markdownlint clean; claims independently re-verified against the cited scripts.
