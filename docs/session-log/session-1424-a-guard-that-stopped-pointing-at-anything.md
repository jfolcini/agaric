# Session 1424 — the space-filter guard had stopped pointing at anything

**Issue:** #3255

The `check-space-filter-drift` guard has been green on every commit since the #2621
workspace split, and that green covered four files out of fifteen. The other eleven moved
into `agaric-store` and the guard never followed them: it matched what was left, found
nothing wrong, and exited 0. This re-scopes it, and adds the check that would have said so.

## Three blind spots, not one

The issue title reads as one fix — re-scope the hook. It is three, and each one alone is
sufficient to keep the guard useless.

**The hook was never selected.** `prek.toml`'s trigger was
`^src-tauri/src/.*\.rs$`, so a commit confined to `agaric-store/` did not run this hook at
all. Widening the guard's scan roots without widening this regex would have fixed nothing
for exactly the commits that matter.

**Eleven of fifteen baseline entries named files that no longer exist.**

```
src-tauri/src/backlink/{grouped,query}.rs
src-tauri/src/pagination/{agenda,hierarchy,links,properties,tags,tasks,trash,undated}.rs
src-tauri/src/tag_query/query.rs
```

**Twenty-one of the thirty-one canonical fragments were outside the walk**, which rooted at
`src-tauri/src/`.

`DENY_FILES` had the same rot in miniature: its single entry named
`space_filter_canonical.rs` relative to `src-tauri/src/`, a path dead since the file moved
to `agaric-store`.

## What was actually lost, and what was not

The sibling Rust parity test in `agaric-store/src/space_filter_canonical.rs` walks both
that crate's `src/` and the app crate's `../src`, and stayed green throughout. So the
*shape* invariant — a drifted bind index, `(?2 … ?3)` — was never unprotected.

What was lost is the half only the baseline can provide. A **removed** guard matches
nothing; there is no occurrence left for a regex to check the shape of. The per-file count
baseline is the only net for removal, and for degradation to a bare `b.space_id = ?N`
(legitimate at many single-space sites, which is why the count baseline exists rather than
a simple ban). That net covered four files.

The re-anchor shows the drift concretely rather than hypothetically:
`backlink/grouped.rs` goes **3 → 5**. Two canonical guards were added while the file was
unwatched. A later removal of either would have restored the stale baseline's 3 and passed.

## The check that closes the class

Widening the scope fixes today. It does not stop the next move from doing this again — and
the next move is already planned (#4499 sequences five more phases of exactly this kind of
relocation).

So the guard now asserts that every baseline and `DENY_FILES` entry names a file that
exists. This is the shape session 1299 identified after hitting four instances in one day
and could not act on generally:

> it walked discovered files and asked "is this one allowed?", never "does this entry still
> name a file?" — That is precisely how the first instance survived.

The check is deliberately unconditional: it runs on a targeted `prek` invocation too,
because the rot is a property of the baseline, not of the files in any one commit. A
version that only ran on a full-tree sweep would be invisible in the pre-commit path, which
is where the guard actually lives.

I first gated the `DENY_FILES` half on "the crate root this entry names is present in
this tree", because the CLI self-test's synthetic repo root has no `agaric-store/` and the
ungated check failed there. The review took that apart, and it is the most useful thing in
this session.

The gate made the check inapplicable to **exactly the mistakes most likely to be made** — a
misspelled crate segment, a crate renamed or retired wholesale. A deny entry naming a crate
root that does not exist read as "not applicable" rather than "dangling", so no run could
ever flag it. Demonstrated with three bogus entries (`agaric-storage/src/typo.rs`,
`agaric-observability/src/nope.rs`, `tests/nope.rs`): the guard exited 0 and said nothing.

The sandbox was what was wrong, not the check. `_build_cli_sandbox` now materialises every
`DENY_FILES` path, so it models a real checkout, and the check is unconditional.

Worse, the rationale I wrote for the gate was **factually false**. It claimed the sandbox
"has no `agaric-store/`" — but self-test directions 4 and 5 *create* it. From direction 4
onward every run emitted a dangling-deny finding, so the `code != 0` half of both cases was
satisfied by an unrelated error and only the substring assertions discriminated. I wrote a
confident mechanism into a comment and it was wrong; that is the failure this repo's own
"relayed claims are unverified until you verify them" rule exists for, committed by the
person writing the rule's subject.

## Falsification

Every new case was run against a deliberately broken guard, mutating a **copy** and proving
the restore with `cmp` each time.

| mutant | result |
|---|---|
| `CRATE_ROOTS` narrowed back to `src-tauri/src/` only | both widening cases fail |
| `_assert_paths_exist` baseline half neutered | dangling-baseline case fails |
| `_assert_paths_exist` DENY half deleted outright | dangling-deny case fails |
| `dangling` dropped from `main()`'s exit condition | dangling case fails |
| control (restored) | 17 cases pass |

The per-half rows are not padding. My original table had one row for "`_assert_paths_exist`
returns `[]`", which kills both halves at once — and that conflation is precisely why the
DENY half being **completely untested** went unnoticed: deleting it outright left the
self-test output byte-identical and still passing. A mutant that kills two things at once
cannot tell you that only one of them was covered.

The first mutant is the one worth recording. Under it, the whole-tree case still **exits
non-zero** — for an unrelated reason, a Rule-A drift in a different fixture file. A case
asserting only `code != 0` would have passed against a guard with the widening removed.
Asserting on the specific filename (`sub_drift.rs`) is what discriminates.

That is the "assertion that is true for two reasons" failure mode. I caught it in one place
and then committed it in another: the dangling-deny pollution described above is the same
bug, in the cases I had just written to defend against it. Review caught that one, not me.

And the whole fix, end to end, against the tree as it stood this morning:

```
$ git show HEAD:src-tauri/space-filter-baseline.txt > src-tauri/space-filter-baseline.txt
$ python3 scripts/check-space-filter-drift.py
  src-tauri/src/backlink/grouped.rs: baseline names a file that does not exist …
  … 11 entries …
$ echo $?
1
```

The `prek.toml` half separately: with the old regex, `prek run --files
src-tauri/agaric-store/src/backlink/query.rs check-space-filter-drift` reports **`(no files
to check) Skipped`**; with the new one, `Passed`.

## Verification

- `--self-test`: 17 cases pass (was 10).
- Whole-tree run on the fixed tree: exit 0.
- `prek run` hook selection confirmed on both a member-crate file and an app-crate file.
- `check-hook-deps.mjs`: 0 new gaps, 0 stale.
- `cargo nextest run --workspace -E 'test(space_filter)'`: 8 passed, including both
  `space_filter_canonical` parity tests.

Not run: the full workspace suite. This diff contains no Rust; the parity tests above are
the ones coupled to it.

## A correction to the issue thread

My own comment on #3255 said "26 matching sites in `agaric-store`", from a raw
`grep -c 'IS NULL OR b.space_id'`. The guard's canonical regex counts **21** there — the
grep also matched the canonical constant, prose comments, and structurally-different sites
the guard deliberately does not police. The claim was right in direction and wrong in its
denominator, which is the failure this repo's own rule about denominators names.

## Follow-on

The general form of this — nothing checks that guards still point at anything — is #4501,
filed with the six recorded instances. This session is its first live instance fixed, and
#4501 proposes falsifying the meta-guard against *this* issue's pre-fix state, which is now
recorded above in a reproducible form.

## Review round two

`agaric-reviewer` approved and then listed seven notes, which is the normal shape here — an
approval is not "nothing to address". Four were fixed in a follow-up commit:

- **The dangling hint prescribed a remedy that could not work for half of what it fires on.**
  It offered `--update-baseline`, which rebuilds the baseline and never touches `DENY_FILES`.
  An author hitting a dangling deny entry would run the prescribed command, see nothing
  change, and re-run into the identical message. The hint now names the actual fix.
- **The banner claimed a drift on a dangling-only run.** Nothing had drifted; the header said
  it had. Two headers now, and a self-test case pins it — falsified by reverting to the single
  unconditional banner.
- **Two comments this change made false**, which is the finding worth recording given what the
  section above says about confidently-wrong comments: `_build_cli_sandbox`'s docstring still
  claimed `main()` "only ever scans files under `<REPO_ROOT>/src-tauri/src`", and `main()`'s own
  inline comment still said "only police production .rs under `src-tauri/src/`". Both were
  precise statements of the behaviour this PR removes. I wrote a section about inheriting a
  confidently-wrong comment and left two behind in the same diff.
- **`all_source_files()`'s `seen` set was dead code** — no crate root is a prefix of another, so
  the dedup could never fire. Removed; the `sorted()` it sat next to is load-bearing and stays,
  now with a comment saying why.

Three were left, deliberately: an in-scope-ness check on baseline entries (an entry naming a
file that exists but sits outside `CRATE_ROOTS` is still never walked), a re-anchor that fails
when the total canonical count drops, and a mechanical coupling between `prek.toml`'s regex and
`CRATE_ROOTS`. All three are the same shape one level up — a guard whose scope and whose
subject can drift apart — and belong in #4501 rather than here, where they would be a fourth
hand-maintained pairing defended by prose.

## Review round three

A second approval, six more notes. Two were real and are fixed:

- **`crate_root_paths()` filtered `CRATE_ROOTS` through `is_dir()` and silently dropped what
  was missing.** Misspell or rename a crate segment and the walk narrows to nothing, with no
  signal — this PR's own failure mode, one level up, inside the guard written to end it. Four
  of the six roots carry no baseline entries, so a dangling-baseline finding could not have
  caught it for them indirectly either. `_assert_paths_exist` now flags a root that is not a
  directory, and `_build_cli_sandbox` materialises every root for the same reason it
  materialises `DENY_FILES`.
- **Self-test direction 6 removed a sandbox fixture and never put it back**, and it was the
  last case. Anything appended after it would have inherited a standing dangling-deny finding
  that satisfies the `code != 0` half unconditionally — exactly the pollution the sandbox
  materialisation was added to prevent, reintroduced by the case that tests it.

The second of those is worth being precise about: **it is not falsifiable today.** Because the
case is last, removing the restore changes no observable output, and the self-test passes
either way. It is preventive hygiene, not a demonstrated fix, and claiming a mutant killed it
would be the kind of unearned claim this log has already had to correct twice.

The new root case needed narrowing for the same reason. It first removed `agaric-store/src` —
which contains the only `DENY_FILES` stand-in, so the run went non-zero for *two* reasons and
only the substring assertion discriminated. It now removes `agaric-engine/src`, which holds no
deny entry, so exactly one thing can make that run fail. With the check removed, the case now
yields `(0, '')` rather than a non-zero exit for the wrong cause.

Four notes are left to #4501, where they belong: the `prek.toml` ↔ `CRATE_ROOTS` pairing, the
in-scope-ness of baseline entries, the silent-drop re-anchor, and the Rust parity test walking
two roots while the guard walks six.

## Review round four

A third approval, and one finding that mattered: **adding the baseline file to the hook's
`files:` regex did less than it looked like.**

The intent was that editing `space-filter-baseline.txt` re-runs the guard. It does select the
hook — but every non-`.rs` argument is dropped by the suffix filter, so the target set came out
empty and only the dangling check ran. A hand-edit *lowering* an existing file's count would
therefore pass: the entry still resolves, and no file is scanned to notice the count no longer
matches. That is precisely the edit adding the baseline to `files:` was meant to catch.

`main()` now falls back to the whole-tree walk when arguments were passed but none survived
filtering — which happens only for the baseline itself and the two guard scripts in the regex,
never on an ordinary `.rs` commit. The walk is 3.5s. Falsified: with the fallback removed the
new case yields `(0, '')`.

**And a confirmation the reviewer asked for rather than asserted.** They suspected a commit
that only *deletes* a baselined file would not select the hook, since prek does not pass
deleted paths. Checked directly:

```
$ prek run --files src-tauri/agaric-store/src/does_not_exist.rs check-space-filter-drift
space-filter drift guard (#139)..............................(no files to check)Skipped
```

Confirmed. The gap is real and deliberately not closed here: closing it means `always_run`,
which spends 3.5s on every commit in the repo to cover a case where CI's all-files sweep
already fires, and where deleting a module in practice also edits an in-scope `mod.rs`. Worth
recording as a known limit rather than paying that toll — and worth revisiting in #4501, where
the same question arises for every ratchet guard, not just this one.

The reviewer also caught the PR description still claiming "10 → 14 cases" against an actual
17 — in a change whose whole argument is about denominators being right. Corrected.

## Review round five

A fourth approval, three more fixes.

- **`sorted(DENY_FILES)[0]` would have crashed with an opaque `IndexError` if the set were
  ever emptied** — a legitimate config change, since its sole entry exists only because
  `space_filter_canonical.rs` holds the canonical const. It also exercised only the first
  entry, so a second would have shipped untested. Now iterates every entry and skips cleanly
  when the set is empty; verified by emptying it, where the suite passes instead of throwing.
- **`--update-baseline` never ran the existence checks.** With a misspelled root,
  `compute_baseline()` silently wrote a *narrowed* baseline — the damage happening at the
  exact moment the operator is looking somewhere else, with the report deferred to the next
  ordinary run. The checks now run first and warn. Falsified by misspelling `agaric-engine`:
  the warning fires and names the root before the rebuild.
- **The guard and its sibling Rust parity test had diverged in scope** — the guard now walks
  six roots, the test still walks two — and the test's own `DENY_FILES` comment claimed its
  paths were "relative to `src-tauri/src/`", which was already false for the one entry it
  holds. Both now carry a keep-in-step cross-reference naming the other. Nothing is unguarded
  today, since the other four crates hold no `b.space_id` read; the point is that the two
  lists could drift apart silently, which is this change's own subject one level over.

One note deliberately declined: a whole-`src-tauri` sweep asserting every `b.space_id`
occurrence falls under a listed root. It would close the inverse blind spot — a read landing
in an *unlisted* crate — and it is a good idea, but it is a new check rather than a repair of
this one, and widening the PR on my own is how a focused fix becomes an unreviewable one. It
is on #4501 with the rest.

## A pattern worth naming, about this session rather than the code

Four review rounds, and the reviewer found something real in every one — including two cases
where the bug I had just written was an instance of the class I was fixing: a self-test case
that leaked its fixture into the next case, and a case that passed for two reasons inside the
fix for a case that passed for two reasons. The guard is better for it, and the honest reading
is that the first version was not close to done when I thought it was.

Also worth recording: three `validate-all` failures on this branch were **self-inflicted** —
each was a run cancelled by the next push landing on top of it, and the gate correctly counts
cancelled as unacceptable. Pushing a fix the moment it is ready costs a CI cycle when reviews
are arriving faster than CI completes. Batching the round-four and round-five fixes into one
push would have been better.
