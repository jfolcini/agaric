# Session 1639 — kill-dates for the baselines that want one

Fourteen guard baselines record violations the project has agreed to keep, and
none of them says for how long. #4885 asked for the temporal dimension, and left
open whether every baseline wants it. It does not. Four do.

#4129 is the precedent one level up: `migrate_personal_pages_to_work` carried
`REMOVE AFTER 0.3.0` in its own doc comment and was still exported, reachable
and running a boot-time query at 0.9.8, removed only because a deep review
happened to read the comment. `remove-after-markers` exists because the
containment mechanism was "a human remembers at release time". A baseline entry
is the same shape: a guard switched off for a file, with nothing that ever asks
whether it is still needed.

## Which four, and why the other ten are not debt

The test I used is the one the marker's own failure text implies — "delete the
code the marker guards" — so a `REMOVE AFTER` is honest only on a baseline whose
declared completion criterion is that it is *empty*. Four qualify, and all four
say so in their own guard headers:

`tauri-import-baseline.json` is the migration off `@/lib/tauri`, a layer AGENTS.md
documents as frozen and legacy. Its guard's header names the completion criterion
outright: "the migration is complete when the baseline is `[]`". 39 files, 23
commits since 2026-07-22, still moving — the last one landed yesterday.

`lib-layering-baseline.json` is the tier-direction ratchet from #3121, whose step
2 is explicitly the burn-down. Thirteen entries, three commits ever, and nothing
since 2026-08-22. It is the most stalled of the four and the clearest case for a
date.

`strict-invoke-optout-baseline.json` lists test files that replace the strict
`invoke` mock and so lose the mechanism that caught #3217's silent behaviour
inversion — a "delete fails" test that quietly exercised the delete-succeeds path
and passed. Eight files; the fix per file is `vi.fn(strictInvokeFallback)`.

`json-parse-cast-baseline.json` counts `JSON.parse(...) as T` sites, eleven across
nine files, each one a shape assertion over data that came back out of storage.
The end state is `{}` — every site behind a real validator.

The other ten fail that test, for four distinct reasons, and stamping a kill-date
on them would make things that are not debt look like debt:

*Not violations at all.* `space-filter-baseline.txt` counts occurrences of the
canonical `(?N IS NULL OR b.space_id = ?N)` fragment and fails when a count drops
*or* rises. The entries are the guards, not the debt; `REMOVE AFTER` on that file
would read as an instruction to delete space filtering. `coverage-baseline.json`
is two measured percentages, and `metric-firing-baseline.json`'s single row says
`bg_deduped`'s firing is proven, just not in a shape the guard's textual matcher
credits — a carve-out in the guard's expressiveness, permanent until the guard
learns the shape.

*Inventories that are meant to grow.* `bulk-equivalence-baseline.json` records a
disposition for every bulk-named function in the workspace; its guard's own
header says it "does not judge code, it judges whether a decision was recorded".
Of fifty rows exactly one is a `gap`; the rest are `covered`, `converged`,
`wrapper`, `not-a-fan-out` and `exception`. A new bulk function adds a row
forever.

*Closed historical sets.* `migrations-mock-ack-baseline.txt` (123 filenames) and
`migrations-test-coverage-baseline.txt` (111 numbers) grandfather migrations that
predate their conventions. Migrations are immutable and append-only, so neither
set can grow and neither will shrink; they are watermarks, and a watermark with
an expiry is theatre by construction.

*Ceilings whose floor is not zero.* `dynamic-sql-baseline.txt` records per-file
counts of runtime `sqlx::query(` sites. Adding the required `// dynamic-sql:`
marker does not lower a count — only deleting a site does — and dynamic SQL is a
legitimate form here, so the baseline emptying is not the goal and never was.
`table-ownership-baseline.txt` is the same shape, and already carries the
temporal information per entry: its `--update-baseline` preserves an inline
`# …` on each pair, and the header says that annotation records whether a
cross-crate write "is a sanctioned carve-out or WHEN it migrates". That is
strictly better than a whole-file date, and it is the model the other baselines
should copy if per-entry expiry is ever built.

Two were close calls and are recorded as such. `doc-code-paths-baseline.json`
holds 61 dead citations, 58 of them "not yet fixed" — real debt by any reading —
but three are permanent (prose that deliberately describes a removed file), so
the file can never be empty and a whole-file `REMOVE AFTER` would be a lie that
gets bumped every release. `content-regex-baseline.json` has three entries, two
real and unfixed, one whose own reason field says the residual "is DELIBERATE and
cannot shrink". Both want per-entry expiry, which #4885 itself calls the richer
version and not the first step.

## Where the markers went, and why not into the baselines

Into the four guard scripts' headers, beside the completion criterion each one
already states. No change to `check-remove-after-markers.mjs` and none to
`prek.toml`: its `SCAN_EXT_RE` already covers `.mjs`, so the markers are live
today, and every commit touching any `.rs`/`.ts`/`.tsx`/`.py`/`.sh`/`.md` file —
plus every `bump-version.sh` commit, which is #4129's own designed trigger —
re-scans the whole tracked tree and reads them.

The baseline files themselves were the obvious home and are the wrong one. Three
of the four are `JSON.stringify(sorted, null, 2)` output, regenerated whole by
`--update-baseline`; a hand-written line in a generated file is the defect
#3659 already records against `check-dynamic-sql` (a single hand-edited line into
a generated baseline, called "the interface's fault"). Two are JSON *arrays*,
which cannot carry a comment at all without becoming objects — a format change
rippling through the guard, its writer, and `check-baseline-paths.py`'s
per-file extractor, which would read any injected key or string as a path and
fail it as dangling. And these four baselines, unlike `content-regex` or
`bulk-equivalence`, are bare path lists with no `reason` field: the guard header
is their only prose, so it is where whoever inherits an entry already has to
look.

## The version

`REMOVE AFTER 0.12.0`, the same on all four so they are re-evaluated in one
sweep, the way `.nsprc`'s two advisory exceptions share an expiry for the same
reason. 0.10.0 was cut on 2026-09-08. The last four minors landed 23, 5 and 47
days apart, so two minors of headroom is roughly seven weeks — landing near the
2026-11-12 the `.nsprc` entries already use, which is the repo's only other
temporal exception and the only calibration available. Near enough that emptying
an eight-entry or eleven-site baseline is a real option rather than an automatic
bump; far enough that a 39-file migration is not being asked to finish in a
fortnight. The escape hatch is the marker's own version, bumped in a diff a
reviewer sees.

## Verification

`node scripts/check-remove-after-markers.mjs` exits 0 with the four future
markers in place — which on its own proves nothing, since an unscanned line is
also green. Both red runs were against a `cp` backup, restored, `cmp` confirming
byte identity.

Expired: `REMOVE AFTER 0.12.0` → `0.0.1` in `check-tauri-import-baseline.mjs`.
Exit 1, `scripts/check-tauri-import-baseline.mjs:67: marker 0.0.1, current
0.10.0`, quoting the line and naming both fixes. Malformed: `0.12.0` → `0.12` in
`check-json-parse-cast.mjs`. Exit 1 under the separate "not in the canonical
form" heading — reported, not skipped over as an unparseable line, which is the
fail-closed half.

The guard's own self-test exits 0. All four touched guards run green, and each
one's `--update-baseline` regenerates its baseline byte-identically, so nothing
in the generated files moved. `npm run lint` and `npm run typecheck` are clean,
`check-baseline-paths.py` exits 0, and `git status` shows four modified `.mjs`
files and nothing else.
