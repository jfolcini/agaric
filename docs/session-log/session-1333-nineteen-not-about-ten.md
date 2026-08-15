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

### The nit that survived

One assertion inside the test compares the hardcoded sentinel literal to its own lowercase form, which
is trivially true and cannot detect drift from `tree-utils.ts`. The doc comment two paragraphs earlier
is honest that the string is manually duplicated — but the assertion's own framing ("for this test to
exercise the real hazard") overstates what it does.

Left as-is and recorded here, which is the right resting place for a harmless assertion whose comment
promises more than it delivers.

## A sixth stale comment, in a file the fix didn't touch

Review of the PR whose entire subject was stale/false harness-isolation comments found it had
introduced a sixth: `restore_cascade_tests.rs`'s `fresh_loro_state()` doc claimed tests "don't conflict
even running concurrently under plain `cargo test`," while a sibling test in the same file asserts an
exact delta on the process-global `descendant_fanout_dropped` counter — bumped from several sites in
`apply.rs` reachable by other tests in the binary. The comment and the code fifteen lines below it
disagreed with each other.

Fixed to match `create_edit_convergence_tests.rs`'s HOWEVER wording, but with one addition that
wording doesn't need: `restore_cascade_tests` is absent from `.config/nextest.toml`'s
`spy-counter-serial` test-group (confirmed at line 145 — the filter lists
`create_edit_convergence_tests` and five other sibling files, not this one), so unlike those siblings it
has no `max-threads = 1` backstop even under `cargo nextest run`. Its exposure is worse than the
sibling files', not equivalent, and the comment now says so rather than borrowing their reassurance.
