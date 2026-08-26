# Session 1403 — nine goal items, and the traps found carrying them

A nine-item goal, worked mostly in parallel worktrees. The shipped code matters less than
three things the session learned about *how the work goes wrong*, so those come first.

## The assertion that is true for two reasons

This failure mode appeared **twice in one day**, in unrelated code, and neither instance was
found by a guard. It is now the fourth entry in the batch-issues test-coverage list.

In #4328, the test for "undo refuses a replicated target" stayed **green** with the
production check disabled. There are two independent guards —
`verify_undo_targets_in_tx`'s `is_replicated` arm and `reverse::reject_replicated_targets`
in `revert_ops_in_tx` — and both return `Validation`. Only disabling *both* reddens it.

That is the same shape that hid the dead #4018 fix, where a negative assertion
(`!out.contains("root could not be purged")`) held because control fell into a different
branch that returned *before* the log line ever ran.

The question to ask of every negative assertion: **what else could make this true?** If the
answer is "a path I did not intend", assert on something only the intended path produces.

#3294's tests were built to survive this on purpose. The discriminator is the *pair*
(sweep count, remaining rows) — retired `(0,0)`, re-enqueued `(1,1)`, error `(0,1)` — so no
single assertion can pass for a second reason.

## Documenting a guard that does not exist is worse than documenting none

`batch-issues/SKILL.md` credited `scripts/check-disabled-stubs.mjs` as the backstop against
deliberately-disabled fixes. **That script does not exist and never did** — it was proposed
and deliberately not built, as redundant. A subagent had already gone looking for it.

An agent that believes a net exists stops checking. Corrected in #4401 to name the real
backstop — `cargo clippy -- -D warnings`, in both pre-push and CI, where `if false &&` trips
*"this boolean expression contains a logic bug"* and a `return` above live code trips
*"unreachable statement"* — and to say plainly that it is a backstop and **not** a net: a
stub leaving neither unreachable code nor a constant condition compiles clean.

## `reset --soft origin/main` in a shared-`.git` worktree can silently write a revert

While finishing the recovered links WIP, `origin/main` advanced underneath the worktree —
worktrees share `.git` with the main checkout, so an unrelated fetch moves the ref. A
`git reset --soft origin/main` intended to re-split two commits instead produced **a revert
of #4401, #4403 and #4405**: 25 files, 1,422 deletions, including `src/stores/undo.ts`.

Caught in a post-commit `--stat` review, not by any hook. **Pin the SHA.** Never
`reset --soft origin/main` in a worktree whose `.git` is shared.

## #850's scoping comment has been misread

> `// only a newer edit — not e.g. a delete/restore — supersedes here`

This reads as *cross-op-type supersession is unsafe*. It is not. A later `delete_block` does
not supersede a stale `edit_block` because they write **different slots** (`deleted_at` vs
content) — the stale edit's content should still land.

**Supersession is about the slot, not the op type or the value.** Two `edit_block`s already
write opposite *content* into one slot and either supersedes the other, so cross-type gating
was never the novel part. That is what makes `add_tag`/`remove_tag` gateable in #3294: they
are opposite values into one slot, exactly as two edits are.

The issue's own rule needed tightening too. Not *"the later op writes the same slot"* but
**"the later op writes the whole of what the stale op writes."** That refinement is
load-bearing: it is what excludes `create_block`, whose write set
`{existence, type, content, position}` strictly *contains* a move's `{position}`. Under the
looser phrasing a later move would retire the create and the block would never exist.

`delete_block`/`restore_block` stayed deferred rather than widened on a guess — `deleted_at`
is not a per-block slot (see session 1402), so a same-block `created_at` compare is the wrong
decision procedure.

## A ratchet bump that looked justified, and was not

#3294 first used a runtime `sqlx::query_scalar(sql)` with three `WriteSlot` arms differing in
parameter arity, and bumped `dynamic-sql-baseline.txt` 3 → 4. Reviewed and **accepted** —
the arity argument is real, `query_scalar!` cannot express a conditional bind.

Then triplicated instead: one fixed-arity `query_scalar!` per arm. Baseline is now
byte-identical to `main` and the SQL is compile-checked. The sibling gates are runtime for a
*different* reason — numbered-parameter reuse (`?1` six times in #2212's ancestry CTE) — which
this predicate does not need.

**A baseline bump is a last resort. "The macro cannot express this" deserves a second look
before it is believed.**

## Rust doc comments are a public interface

tauri-specta copies Rust doc comments into `src/lib/bindings.ts` as JSDoc. So the 177-link
rustdoc sweep (#4404) changed *generated bindings*, and
`specta_tests::ts_bindings_up_to_date` failed in CI — the only failure across four PRs pushed
without a local gate.

Six IPC-exposed types carried rewritten links. Fixed with `just gen-bindings`; never
hand-edit that file.

The related scoping rule, which explains most of the 177: **when a `mod x;` declaration
carries an outer `///` doc, the links in that module's own `//!` inner docs resolve in the
PARENT's scope.** Absolute `crate::…` paths fix the class.

## Two orders that disagree — #4402

The materializer LWW gates tie-break on `(created_at, device_id, seq)`. `history.rs`,
`pagination/history.rs` and `property_ops.rs` use `(created_at, seq, device_id)`, which
`property_ops.rs` calls canonical in as many words.

Both are total orders — `(device_id, seq)` is the `op_log` PK, so neither can tie — but they
rank the same pair *oppositely*. For two same-`created_at` ops on one slot, A(`aaa`, seq 100)
and B(`zzz`, seq 5): the gates say B is newer and retire A; the history layer says A won. The
sweep can discard exactly the op the rest of the system treats as authoritative, silently.

Pre-existing — all three sibling gates already had the `device_id`-first form. Filed, not
fixed.

## Release identity

`scripts/bump-version.sh --check-identity` refused 0.9.9: committer `t <t@t.t>` is not a UID
on signing key `6CD11759A20B6111`, so the bump commit would land `verified=false` and the
"commits must have verified signatures" rule would be **bypassed rather than satisfied** —
the same way 0.9.4 and 0.9.8 did. Repo-local identity set to the key's only UID
(`Javier Folcini <jfolcini86@gmail.com>`) on a maintainer ruling; the gate then passed.

## Issues split rather than worked

**#4377** (296 React Compiler findings) closed into #4406 `react(refs)` 96, #4407
`react(set-state-in-effect)` 89, #4409 the residual six rules 35 — **220 total, full
coverage**, which is what made closing honest. Plus #4408: `--type-aware` cannot run here at
all, so every count is a lower bound.

That last one corrected a plausible premise. TypeScript 7.0 *is* the native Go port, but
`oxlint-tsgolint` is still a separately-published binary — now version-matched to the
compiler (`7.0.2001` ↔ TS `7.0.2`). TS 7 did not remove the dependency, it aligned it; the
package was simply never added, and `--type-aware` appears in neither `prek.toml` nor CI.

**#2927** split into #4410 (37 dead wrappers), #4411 (PURE + SCOPE), #4412 (the 10
DEFAULTS/RESHAPE — separate because omitting a defaulted field *typechecks* and silently
changes behaviour), #4413 (the floor), #4414 (`AttachmentRow` drift, a live bug).

The reframing that unblocks it: **the floor is ~7 functions, not zero.** Read as "delete the
directory" the issue can never close — `restoreAllDeletedInSpace`/`purgeAllDeletedInSpace`
alone are ~120 LOC of chunked cursor drain.
