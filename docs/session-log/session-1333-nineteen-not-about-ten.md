# Session 1333

## Nineteen, not about ten

#3817 reported "~10 comments" instructing callers to use `shared::install_for_test()`, deleted in
#2249. The real count is **19 lines across 11 files** — and the issue had missed
`restore_cascade_tests.rs` entirely, missed two sites in `integration_tests.rs`, and its own line
numbers had drifted (`conformance.rs:3568` is actually `:3606`).

A count in an issue is a claim like any other. This one was written by someone who looked, and it was
still wrong by half, in a direction that would have left a whole file un-fixed.

### Deleting the dead reference would have been the wrong fix

These comments do not merely name a function that no longer exists — they *instruct* future test
authors. And this repo has a specific reason to care: a Rust apply test without the right harness
setup silently exercises the `sql_only` **fallback** rather than production, which is where a past
false-drift finding came from.

So every one was rewritten to describe the current mechanism — `state: &LoroState` as a required,
always-threaded parameter, the `sql_only_fallback::count()` delta-zero check, and where relevant the
`append_local_op` → `dispatch_op` → settle foreground pipeline. A comment that says nothing is better
than one that misleads; a comment that says the right thing is better than both.

One reference is deliberately kept: `sql_only_fallback.rs:29` documents the deletion in the past tense
("It must NOT come back"), which is the canonical explanation the issue itself pointed at.

Seven-to-nine adjacent citations of `shared::get()` and `shared::init()` — also deleted — were fixed in
the same sentences. Leaving them beside a corrected reference would have been half a fix. Worth noting
the builder reported that as "six": a miscount inside a change whose entire subject is miscounted
citations. No code impact, and recorded because the irony is the point.

### The guard, and why not the existing one

`doc citations point at tracked code` scans `*.md` for a `docs/…§…` pattern and validates *paths*. It
structurally cannot cover a Rust comment citing a Rust symbol, and a general Rust-symbol checker has a
real false-positive problem — name resolution is not substring matching.

So a narrow, incident-scoped guard instead, mirroring the existing `check-architecture-citations.mjs`:
fail on any tracked `.rs` or `.md` citing `install_for_test` outside the one file that legitimately
documents its deletion. The allowlist is an extensible symbol→file map with one entry, not a hardcoded
special case.

The `.md` half was not in the first draft. Review pointed out that
`docs/architecture/sql-only-convergence.md` — the canonical design doc for this exact subsystem, and the
one the guard's own error message tells readers to consult — still prescribed `install_for_test()` in the
present tense. An `.rs`-only guard would never have seen it: the same defect, in the document the fix
points at. Widening the scan meant excluding `docs/session-log/**`, since five session logs cite the
symbol legitimately in the past tense, and widening `prek.toml`'s trigger to `\.(rs|md)$` — without that,
an `.md`-only commit would never invoke the newly-widened scan, and the guard would have been extended in
name only.

Demonstrated rather than asserted: clean tree exits 0; injecting the citation into a tracked file exits
1 with file and line. The sharper evidence is that it fired unprompted — the first draft of the doc
rewrite above named `install_for_test` while describing its replacement, and the guard caught it before
any deliberate injection.

## What the sentinel test actually pins

#3794 says `SENTINEL_ID`'s safety rests on an uppercase normalization introduced for blake3 hash
canonicalization (#1558), not for sentinel safety — so the property holds by coincidence.

The claim holds. `BlockId::from_trusted` and the untrusted `Deserialize` fallback both
`to_ascii_uppercase()` non-ULID input, both docstrings attribute it to #1558, and nothing else stops a
peer-supplied id equal to `__drop-after-last__` colliding with the frontend sentinel. No CHECK
constraint, no id contract.

The review's job was to decide whether the new test pins the real property or a weaker proxy — because
asserting "the sentinel does not survive **verbatim**" invites the obvious objection: what about the
already-uppercased form?

It does not apply, and the reason is worth writing down. The hazard is `overId === SENTINEL_ID` — a
strict comparison against a fixed **lowercase** literal, not a case-insensitive one. The uppercasing is
unconditional over the whole string, and the ULID-parse success path is always uppercase too. Since the
sentinel contains lowercase letters, **no byte sequence an attacker can submit** can normalize to it.
So "verbatim" is not a proxy for "no collision"; given the comparison semantics actually used, it *is*
no collision.

Confirmed non-tautological by mutating `from_trusted` to skip the uppercasing and watching it redden
with both sides reading `__drop-after-last__`.

### ~~The nit that survived~~ — WRONG, corrected below

> **CORRECTION (added while addressing PR #3959's review — the claim below is false).** The struck
> paragraph is kept verbatim rather than deleted, because a session log whose thesis is "a count in an
> issue is a claim like any other" recording an unchecked claim of its own is exactly the kind of thing
> this archive exists to preserve.

~~One assertion inside the test compares the hardcoded sentinel literal to its own lowercase form, which
is trivially true and cannot detect drift from `tree-utils.ts`. The doc comment two paragraphs earlier
is honest that the string is manually duplicated — but the assertion's own framing ("for this test to
exercise the real hazard") overstates what it does.~~

~~Left as-is and recorded here, which is the right resting place for a harmless assertion whose comment
promises more than it delivers.~~

What the assertion actually is: `tree-utils.mutants-drop.test.ts:197` reads `SENTINEL_ID` **imported
from `@/lib/tree-utils`** (`:12`), not a hardcoded literal, and compares it to its own lowercase form.
It is therefore precisely the drift detector the paragraph above claimed it could not be. Verified by
uppercasing `SENTINEL_ID` in `src/lib/tree-utils.ts` and running the file:

```
FAIL  src/lib/__tests__/tree-utils.mutants-drop.test.ts > SENTINEL_ID preconditions (#3794) > SENTINEL_ID is lowercase, so uppercased peer ids cannot collide
AssertionError: expected '__DROP-AFTER-LAST__' to be '__drop-after-last__' // Object.is equality
```

The *duplicated* string is the one in the Rust fixture (`FRONTEND_SENTINEL_ID` in
`agaric-core/src/ulid/tests.rs`), which has no cross-language import available and says so. That is
what the original note confused with the TypeScript assertion.

## A sixth stale comment, in a file the fix didn't touch

Review of the PR whose entire subject was stale/false harness-isolation comments found it had
introduced a sixth: `restore_cascade_tests.rs`'s `fresh_loro_state()` doc claimed tests "don't conflict
even running concurrently under plain `cargo test`," while a sibling test in the same file asserts an
exact delta on the process-global `descendant_fanout_dropped` counter — bumped from several sites in
`apply.rs` reachable by other tests in the binary. The comment and the code fifteen lines below it
disagreed with each other.

Fixed to match `create_edit_convergence_tests.rs`'s HOWEVER wording, but with one addition that
wording doesn't need: ~~`restore_cascade_tests` is absent from `.config/nextest.toml`'s
`spy-counter-serial` test-group (confirmed at line 145 — the filter lists
`create_edit_convergence_tests` and five other sibling files, not this one), so unlike those siblings it
has no `max-threads = 1` backstop even under `cargo nextest run`. Its exposure is worse than the
sibling files', not equivalent, and the comment now says so rather than borrowing their reassurance.~~

> **CORRECTION (same review pass as above).** The absence from the group is a fact; the conclusion drawn
> from it was not. `max-threads = 1` does not force a test onto its own process — nextest already runs
> every test in its own process, grouped or not — so group membership has no bearing on counter-delta
> safety and `restore_cascade_tests`'s exposure is the *same* as its siblings', not worse. See the next
> section.

## The fix for a stale justification was itself a wrong justification

PR #3959 exists because comments outlived the mechanism they described. Its review found that the
replacement comments had done the same thing again, one layer down.

Five files — `tag_convergence_tests.rs`, `move_convergence_tests.rs`,
`delete_restore_convergence_tests.rs`, `apply_reproject_proptest.rs`, `restore_cascade_tests.rs` — told
the reader that `sql_only_fallback::count()` deltas are safe under `cargo nextest run` because
`.config/nextest.toml` pins them into `[test-groups.spy-counter-serial]` with `max-threads = 1`, "the
isolation requirement did not disappear — it MOVED to an explicit nextest test-group". The advice was
right and the reason was wrong. nextest "executes each individual test in a separate process"
(nexte.st, *How nextest works*) for **every** test, grouped or not; a test group is a concurrency
semaphore over its members, so one permit serialises the group and grants no isolation that wasn't
already there. Group membership is not what makes those deltas valid.

Two consequences followed from getting it wrong. `restore_cascade_tests.rs` reasoned from the false
mechanism to a false ranking — "its exposure is worse than theirs, not merely equivalent" — when the
truth is that group membership makes no difference to counter pollution at all: every one of these
files is safe under nextest and unsafe under concurrent plain `cargo test`, alike. And `shared.rs`'s
module doc, the file readers are pointed at, said flatly that "the nextest-only constraint is gone",
which is true of engine state (#2249 killed the `OnceLock` registry) and false of every counter-delta
assertion in the tree. All of it now says the same, checkable thing.

Two in-tree comments already had it right and were used as the cross-check:
`create_edit_convergence_tests.rs:56` ("These count-delta arms therefore still require
process-per-test") and `engine_path_tests.rs:670` ("Under nextest's process-per-test isolation"). The
wrong version was not the only version available — it was written without consulting the right one.

Not touched, and worth flagging: `.config/nextest.toml:127-140` justifies the group in the same
same-process terms ("a sibling test in this set could corrupt a peer's delta"), which cannot happen
under nextest. That comment predates this PR (last modified in #3639) and the flakiness it cites was
measured, so re-attributing it needs evidence this session does not have. The corrected comments cite
the file for the fact of the pin only, never for the reason.

## And the log recorded a claim it had not checked

The "nit that survived" section above asserted that a TypeScript assertion was tautological. It is not;
`SENTINEL_ID` is imported, and uppercasing it in `tree-utils.ts` reddens the test, as the pasted output
in that section now shows. The paragraph is struck rather than deleted.

A change whose thesis is *a count in an issue is a claim like any other* shipped, in the same commit
series, (a) a mechanism explanation that was mechanically wrong and (b) an archived finding that was
never verified. Both were caught by review rather than by the author. The guard this PR adds catches
one narrow class of stale citation — a deleted symbol named verbatim — and nothing about wrong
*reasoning*, which is the larger and less tractable half.

## The rest of the review pass

- **`snapshot.rs:981-998`** told readers to "install the process-global state" and cited
  `crate::loro::shared::get()` twice, three lines above code that constructs an `Arc<LoroState>` and
  passes it as a parameter. Fixed. Sweeping for the same defect turned up three more the PR had missed:
  `session_state_machine.rs:1058` (a broken intra-doc link to the deleted symbol),
  `create_edit_convergence_tests.rs:7` and `:362` (`shared::get() == None` as the live dispatch
  condition — the real conditions are `SpaceUnresolved` / `EngineMissingTarget`), plus
  `sync_daemon/tests.rs:4647` and `import_scaling_tests.rs:19`, both still describing engine state as a
  process global. The `install_for_test` sweep was complete; the `shared::get`/`init` sweep was not.
- **The guard cannot close that gap, and now says so.** `get` and `init` are ubiquitous live
  identifiers, so a `\b`-anchored matcher on either would fire on nearly every file, and matching the
  qualified path would miss the prose and intra-doc-link forms the real citations take. Recorded as a
  KNOWN COVERAGE GAP in the script header and in `prek.toml`, rather than left to imply the sweep is
  automated.
- **`docs/architecture/sql-only-convergence.md:51`** still framed the #891 lesson as "an apply test with
  no engine *installed*". There is no install step anymore. Retargeted to the wording the `.rs` files
  already carry, with the pre-#2249 phrasing kept in parentheses so the change is legible.
- **`--self-test` was wired into `prek.toml`** as `dead-symbol-citations-selftest`, triggered on the
  guard script's own path, following the `lib-layering-selftest` pattern. Demonstrated RED by
  restoring the fail-open `catch`: `self-test FAILED: expected exit 2 with git missing from PATH, got
  0`. A self-test nothing runs is not a guard.
- **`ulid/tests.rs` pinned only "not verbatim".** Added `assert_eq!(trusted.as_str(),
  "__DROP-AFTER-LAST__")` on both ingest paths. RED demo: mutating `from_trusted` to
  `to_ascii_uppercase().replace('-', "_")` slides past both `assert_ne!`s untouched and is caught only
  by the new assertion (`left: "__DROP_AFTER_LAST__"`).
- **`maxBuffer`.** `git ls-files` is 4,572 paths / ~278 KB against Node's 1 MB default — ~27% consumed,
  overflow at roughly 17k files. Raised to 64 MB in `check-dead-symbol-citations.mjs` **and** its
  sibling `check-architecture-citations.mjs`, because their failure modes differ and both are bad: the
  former turns overflow into an exit-2 that fails every commit, the latter swallows it in a bare
  `catch` and silently disables the guard. Fixed rather than filed: a two-line change is smaller than
  the issue that would track it.
