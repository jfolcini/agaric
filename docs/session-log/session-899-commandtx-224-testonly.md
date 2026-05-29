## Session 899 — #224 resolved: op_log/dag raw-tx sites are test/bench-only (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | #224 |
| **Items modified** | — |
| **Tests added** | +0 (documentation + lint-hook fix; no behavior change) |
| **Files touched** | 3 |

**Summary:** Investigated #224 (route `op_log`/`dag` raw `begin_with("BEGIN IMMEDIATE")`
sites through the `CommandTx` convention) and found its premise no longer holds: the
three flagged sites — `op_log::append_local_op`, `op_log::append_local_op_at`, and
`dag::append_merge_op` — are **test/bench-only convenience wrappers**. Every caller lives
in a `#[cfg(test)]` module or in `benches/op_log_bench.rs`; production appends go through
the `*_in_tx` variants on an outer `CommandTx`, which already couple post-commit
materializer dispatch to the commit. No production refactor is needed. Resolution:
document the wrappers as test/bench-only, give each raw-tx line a permanent per-site
`// allow-raw-tx:` marker, drop the temporary file-allowlist entries, and harden the lint
hook so it no longer false-positives on rustdoc mentions of the tx string.

**Files touched (this session):**
- `src-tauri/src/op_log.rs` (doc rewording on `append_local_op`/`append_local_op_at`; permanent per-site marker)
- `src-tauri/src/dag.rs` (doc rewording on `append_merge_op`; permanent per-site marker)
- `scripts/check-raw-tx.py` (skip `//`-comment lines so rustdoc mentions of `begin_with("BEGIN IMMEDIATE")` aren't flagged; removed TEMP op_log.rs/dag.rs file-allowlist, replaced with a resolved-#224 note)

**Verification:**
- `SQLX_OFFLINE=true cargo check --all-targets` — 0 errors, benches compile, no unused imports.
- `python3 scripts/check-raw-tx.py $(git ls-files 'src-tauri/src/*.rs')` — 0 violations.
- `cargo nextest run op_log dag` — 146 tests run, 146 passed.

**Process notes:** A first attempt gated the wrappers with `#[cfg(test)]`; that broke
`benches/op_log_bench.rs` (benches are not `cfg(test)`) and left unused imports. Reverted
— "test/bench-only" must stay callable from benches, so the right tool is documentation +
a per-site lint marker, not a cfg gate. Also: the lint hook only honors `// allow-raw-tx:`
on the line itself or the *single* line immediately above, so the marker must be the last
comment line before the tx.

**Lessons learned (for future sessions):** Before executing a refactor issue, verify its
premise against the call graph — a "route these through the convention" issue can dissolve
into "document why they're already exempt." Bench-used helpers can't be `#[cfg(test)]`.

**Commit plan:** single commit / pushed.
