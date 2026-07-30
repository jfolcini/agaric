# Session 1242 — retiring surface, and four tools that were measuring the wrong thing

`/loop /batch-issues` run, 2026-07-30. Sixth log for the day (1237–1241 precede it).

The batch started on Dependabot leftovers and ended up mostly about *measurement*: four
separate places where a tool reported a number that was not the number anyone thought it
was. None of them were failing. That is the point — each one was green, or quiet, while
covering less than it claimed.

## #3239 — the lockfile Dependabot stranded

`src-tauri/fuzz` is its own workspace with an independent `Cargo.lock`, excluded from the
parent's `members`, covered by neither `cargo audit` nor `deny.toml` (both are
`working-directory: src-tauri`), and compiled only monthly by `scheduled-deep-checks.yml`.

When #3236 bumped `base64` to 0.23.0 in the parent, Dependabot auto-closed the fuzz-side PR
(#3235) as superseded — but the two locks are genuinely independent, so nothing updated the
fuzz one. `base64 = "0.22.1"` means `^0.22.1`, which 0.23.0 does not satisfy, so the lock was
not merely stale but unsatisfiable. `cargo metadata --locked` exits 101 on it; that is the
cheap test.

Regenerating moved `agaric`, `agaric-store` and `agaric-sync` to 0.23.0 and correctly
*retained* 0.22.1 and 0.21.7 for transitive deps. Nine insertions, three deletions.

The window here is a month wide: the only job that compiles this workspace runs monthly, so
an unsatisfiable lock would have sat undetected until then.

## #3237 — a bundle number that was double what the builder reported

Dependabot's npm minor/patch group. Two things needed fixing before it could merge, and the
review changed the account of both.

The builder reported the `ui-radix` bundle growing 30,649 → 33,227 B (+8.4%). The reviewer
back-solved the *committed* budget instead of trusting the report — the formula is
`ceil(measured × 1.1)`, so 31,740 ÷ 1.1 gives a true prior of 28,854, i.e. **+15.2%**,
roughly double. Re-baselining was still correct; the narrative was not. The actual cause is
boring and real: esbuild `__name()` and `@__PURE__` annotations, traced by diffing the
published npm tarballs rather than inferring from version numbers.

The second fix was the one that mattered. knip 6.29 reported unused exports in five pure
barrel files, and the builder added all five to knip's `entry` array — including
`src/lib/observability/index.ts`, which is **not** a barrel. It defines five real functions.
A file listed as an entry point can never have its exports reported unused again, so that
would have permanently exempted live code from dead-code detection — the exact failure
#3209 exists to prevent. The reviewer pulled it out and used a targeted `@public` on the one
re-export line instead. `@public` is per-symbol; `entry` is per-file and forever.

**Dependabot force-rebased over the fix commit while it was in flight.** `git ls-remote`
showed a SHA I had not pushed. Recovered with `git rebase --onto FETCH_HEAD` and
`--force-with-lease`. Worth knowing: their rebase silently wins, so a push onto a Dependabot
branch needs its SHA verified afterwards, not its exit code.

## #3241 — four assurance-case claims that overstated the posture

The assigned task (write bucket 5a of #80) turned out to be already done, so the work
inverted into an audit of the existing document. Four claims in
`docs/architecture/threat-model.md` had evidence that does not exist — including a citation
to `SECURITY.md#out-of-scope` for text that appears nowhere in that file.

A second agent re-derived all four from primary sources and tightened one further
("several" → "two of the 23" `deny.toml` ignores). Every one of the four errors overstated
security posture, which is the dangerous direction for a document whose whole purpose is to
be believed.

`validate_loopback_endpoint` (`agaric-observability/src/config.rs:175`) was checked directly
and does genuinely enforce loopback — `127.0.0.1.evil.com` is rejected, redirects are
disabled at `otlp.rs:124`. That claim survived; it just needed to be stated at its true
strength.

## #3218 + #3240 — two guards pulling in opposite directions

`check-tauri-bindings-parity.mjs` asserted name-parity between `src/lib/tauri/` wrappers and
`commands.*`. Every #2927 phase mechanically moves another entry into its `KNOWN_UNWRAPPED`
allowlist — 33 of 141 — so it trends toward allowlisting everything and asserting nothing,
while still costing a hook run per commit. And it pulls directly against
`check-tauri-import-baseline.mjs`, a monotonic ratchet that *forbids* adding the importers
this guard's "wrap it" direction would require. The signature-drift class it advertised was
Phase 2, still deferred.

**The issue's own premise was wrong.** #3218's body says "#2927 reads as yes [reach zero
wrappers]". #2927's literal text says to keep genuinely value-adding wrappers (SpaceScope
translation, pagination, channels) in a small named module. The builder followed the source
over the paraphrase and retired the guard rather than inverting it. Both reviews agreed.

#3240 (dead `getLogDir`) was grouped onto the same branch — same investigation, same class
of retired surface, and one heavy push instead of two. Two details worth keeping:

- The `check-tauri-command-instrumented.mjs` allowlist edit was **mandatory, not cosmetic**.
  That script self-tests for stale entries and hard-fails on one naming a command that no
  longer exists.
- Review found a **fourth** doc file still advertising the retired guard, in a list the task
  never named. Nothing catches that automatically: `architecture-citations` validates section
  anchors, not hook-name prose.

The 141 → 140 mock-parity decrement was verified as *exactly* this command by diffing the
extracted `__TAURI_INVOKE` name sets, rather than accepting a count that happened to move by
one.

## #3226 — durable quarantine, shipped as `Refs` not `Closes`

Migration 0106 adds `unresolved_boots` to `loro_sync_inbox` and a `loro_sync_quarantine`
table; `note_unresolved_slot` moves a blob between them in one transaction so it is in
exactly one table at every observable instant — the #535 argument.

The atomicity claim held up under review, verified column-by-column against the real
migration files rather than the summary. So did the `declared_end_vv` JSON round-trip, which
was worth checking because peer IDs are u64 and JSON numbers are f64 — peers really are
stringified in the code, and nothing decodes the column back, so there is no second
serializer to get it wrong.

Three things did not hold:

- **`check-raw-tx` failed outright** on both `begin_immediate_logged` sites. Blocking; fixed
  with justified escape hatches.
- **The standing-backlog `tracing::error!` reinstated the problem the issue exists to end.**
  #3226's own words are "an error every boot forever is not a finished story"; an
  unconditional `error!` whenever the backlog is non-zero is that, one level up. Now `error!`
  only on a boot that actually moved something, `warn!` for the unchanged backlog.
- **A census bug**: a failed *before* read defaulted to `0`, which would have attributed the
  entire pre-existing backlog to the current boot.

**Re-admission is unreachable as shipped.** The design justifies manual-only re-admission at
length, but no shipped code can call `readmit_quarantined_slot` — no command, no CLI, no UI —
and three of the module's five public functions have test-only callers. #3226's acceptance
criterion is "discoverable without reading logs", so this PR says `Refs`, not `Closes`. The
surfacing command was deliberately *not* added here: it would regenerate `bindings.ts`, which
the #3218/#3240 branch was already rewriting, and two branches regenerating that file is a
guaranteed conflict.

That unreachability also collapses the `QUARANTINE_AFTER_BOOTS = 5` justification, which
leans on "erring low is cheap because re-admission puts them back". The threshold comment is
honest that it is unmeasured; the axis is still wrong, and that is #3244.

## #3142 slice B — the survivor counts were wrong twice over

Two independent measurement bugs, stacked:

1. **`stryker.modules.mjs` was under-scoped.** Four `tree-utils.mutants-*.test.ts` files
   existed — added by an earlier PR for this same issue — but were never wired into the
   module's `tests` array. The scoped run therefore never executed them and kept reporting
   mutants those tests already kill.
2. **The issue body double-counts everything.** 114 lines for `glob-validate`, 57 unique —
   exactly 2×, because every survivor appears under both "New this run" and "All
   currently-known survivors". So the section a triager would naturally prioritise is the one
   carrying no information. Filed as #3245.

Between them, `tree-utils` read as 78 survivors when the true count was 22.

Two genuine kills in `tree-utils` (`:538` `?? -1` fallback, `:543` the depth half of a
sibling predicate) — both in places where the *existing* tests' comments claimed coverage
they did not have.

The `glob-validate` triage returned 24 of 24 survivors as equivalent mutants — and flagged
itself as needing a sanity check. That was the right instinct: **3 of the 24 were real.**

The refutation pass did not argue mutant-by-mutant. It generated all 24 mutants mechanically
by exact character-range replacement driven by Stryker's own JSON report, then differentially
fuzzed each against the original across the whole exported surface over 108,752 inputs.

Line 303 (×3) broke. The claim was that leaving a leading `^` unconsumed in a character class
is byte-identical, because `[` + `^` + body equals `[` + body-starting-with-`^`. True in
isolation — but it ignores line 309, the rule that a `]` immediately after `[` or `[^` is a
literal member rather than the close. Consuming the `^` is what positions the index on that
`]`. Leave it unconsumed and the `]` closes the class instead: `[^]]` compiles to "any char
but `]`" originally and "any char, then `]`" mutated.

`[^abc]` — the only shape the existing tests covered — is genuinely byte-identical, which is
precisely why this survived. The first analysis probed multiple leading `^`, escaped `^`, `^`
after a range; all of those really are equivalent. It probed the wrong edge.

Worth recording which way the two analyses erred: the group the first agent flagged as *most*
suspect (off-by-one loop bounds) was the one it got right, and the group it called "proved
algebraically" was the one that broke.

The remaining 21 survived 108k differential inputs plus line-by-line derivation, and several
are structurally unkillable — a dead ternary arm, a private function's return value, and cap
arithmetic that preserves order. Follow-up in #3248.

## Issues filed

#3242 (quarantine budget is per-row but the pathology is per-blob), #3243 (the #1054 RESET tx
does not wipe the new quarantine table), #3244 (the budget counts boots while healing follows
sync cadence), #3245 (the mutation filing script's "New this run" section is the full known
set), #3246 (the log-dir divergence test no longer models the two paths it guards).

## Notes

- Memory was the binding constraint all session: a full Rust debug build is ~18–24 GB on a
  28 GB machine, so only one fits. The useful move was splitting the #3226 review into an
  **analysis-only** pass that verified every claim against sources without touching cargo,
  and deferring execution to a second run. Most of a review's value does not need a compiler.
- A consequence worth stating plainly: the #3226 diff reached its verification run having
  **never been compiled** — neither the builder's nor the reviewer's edits. That is a fine
  trade when the machine forces it, but the first compile is then a real event, not a
  formality.
- Grouping #3240 onto #3218's branch saved a whole heavy push cycle. The cohesion test was
  genuine: #3218's own allowlist comment is where the dead `getLogDir` was recorded.
- Every review this session changed its item's outcome. Two refuted a builder's claim, one
  refuted the issue's own premise, one refuted a claim the *previous* review had made, and
  one caught a permanent dead-code blind spot a day before it would have become invisible.
