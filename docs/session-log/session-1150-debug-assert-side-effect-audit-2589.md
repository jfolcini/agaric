## Session 1150 — `debug_assert!` side-effect audit (#2589) (2026-07-11)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-11 |
| **Items closed** | `#2589` |
| **Dimension** | correctness / release-vs-debug behavioral parity |
| **Tests added** | 0 (audit — no offenders found) |
| **Files touched** | 1 (`AGENTS.md` convention note) |
| **Schema / wire-format** | none |

**Prompt:** Bun's Zig→Rust rewrite writeup (https://bun.com/blog/bun-in-rust) reported
that their worst ported regression (oven-sh/bun#30678) was a **state mutation living
inside a `debug_assert!`** — a macro compiled out in release, so the effect silently
vanished in production while passing every debug test. This is a universal-Rust footgun,
and our release profile makes it bite hardest: `src-tauri/Cargo.toml` sets
`debug-assertions` off, `panic = "abort"`, `strip = "symbols"`, so `debug_assert*!`
bodies are fully elided.

**Method:** Enumerated every real `debug_assert!` / `debug_assert_eq!` / `debug_assert_ne!`
**invocation** in `src-tauri/src` (`^\s*debug_assert…` — excluding the ~67 comment mentions
of the macro, which discuss the elision semantics but are not calls). Read each asserted
expression and classified it as pure (no mutation, no side-effecting method, no reliance on
a fallible call's effect) or an offender.

**Result: 21 invocation sites, all side-effect-free. Zero offenders.** The codebase is
already disciplined here — many sites carry comments explicitly reasoning about the
release-elision behavior and pair the `debug_assert!` with a release-active guard
(`return Err(...)`) on the production path.

| # | Site | Asserted expression | Verdict |
|---|------|---------------------|---------|
| 1–4 | `hash.rs:77,81,85,90` | `!x.contains('\0')` (device_id, parent_seqs, op_type, payload) | pure |
| 5 | `sync_protocol/session_state_machine.rs:864` | `false` (unreachable-arm marker) | pure |
| 6 | `filters/assembly.rs:84` | `!wc.is_unsupported()` | pure |
| 7 | `filters/primitive.rs:1084` | `parsed.is_ok()` — `parsed` bound at :1078, used at :1089 regardless | pure |
| 8 | `commands/queries.rs:1411` | `next_param - 6 == prop_binds.len() + tag_binds.len()` | pure |
| 9 | `recovery/draft_recovery.rs:117` | `!block_id.is_empty() && block_id.chars().all(alnum)` | pure |
| 10 | `recovery/draft_recovery.rs:240` | same shape | pure |
| 11 | `fts/filter_builder.rs:646` | `alias == "b"` | pure |
| 12 | `fts/index.rs:629` | `count <= 1` | pure |
| 13 | `bibliography.rs:198` | `chars.get(*pos) == Some(&'{')` | pure |
| 14 | `bibliography.rs:764` | `slice.first() == Some(&'\\')` | pure |
| 15 | `db/command_tx.rs:392` | `!self.committed \|\| self.pending.is_empty()` | pure |
| 16 | `spaces/tests.rs:627` | `id.len() == 26` (test) | pure |
| 17 | `materializer/dispatch.rs:879` | `!block_id.is_empty()` | pure |
| 18 | `materializer/handlers/apply.rs:186` | `single_device` (bool bound above) | pure |
| 19 | `cache/tests.rs:1158` | `id.len() == 26` (test) | pure |
| 20 | `materializer/handlers/task_handlers.rs:51` | `records.first().is_none_or(\|f\| records.iter().all(...))` | pure |
| 21 | `mcp/activity.rs:201` | `cap > 0` | pure |

Note sites 18 and 20 (single-device batch/apply cursor invariants) already have an explicit
release-active `return Err(AppError::InvalidOperation(...))` counterpart immediately after the
`debug_assert!` (apply.rs #412, task_handlers.rs) — the correct pattern when an invariant must
also hold in release.

**Regression guard:** There is no reliable static lint for "side effect inside `debug_assert!`"
(clippy has none; a grep heuristic would be false-positive-prone), so instead of a fragile CI
check we added a convention note — `AGENTS.md` "Backend Patterns" item 7 — recording the rule
and pointing at the `debug_assert!` + release-`Err` pairing as the sanctioned pattern for
release-critical invariants.

**Files touched:**
- `AGENTS.md` — new "Backend Patterns (commonly caught in review)" item 7 (no side effects inside `debug_assert!`).
