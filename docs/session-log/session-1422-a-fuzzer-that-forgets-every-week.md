# Session 1422 — a fuzzer that forgets every week

The `fuzz` lane has been green every week it has run, and that green meant less than it
looked like. It uploaded `src-tauri/fuzz/corpus/` as an artifact and nothing ever restored
it, so every run started all five targets from whatever was committed to git and threw away
the coverage it found. This makes the corpus persist (#4496).

## The lane was measuring the same shallow frontier, over and over

Coverage-guided fuzzing works by accumulation: each interesting input is kept, mutated, and
becomes the launch point for the next. `-max_total_time=120` is not "120 seconds of
fuzzing" — it is 120 seconds *from wherever the corpus already reaches*. Discard the corpus
and it is 120 seconds from cold, permanently.

What was actually on disk at the start of each run:

```
$ git ls-files src-tauri/fuzz/corpus | cut -d/ -f4 | sort | uniq -c
      5 deeplink_parse
      3 snapshot_decode
```

Eight files across two of five targets. `import_parse`, `fts_strip` and `html_parse` had no
corpus directory at all — libFuzzer started them from its single empty input, every week.

The near-miss in the diagnosis is worth recording: the job *does* carry a cache
(`Swatinem/rust-cache`, `workspaces: src-tauri/fuzz`), which reads as "the corpus is
cached" until you check what that action's paths actually are — `~/.cargo` and `target/`.
A cache that exists is not a cache of the thing you care about.

## Three steps, and a justification that was wrong

The first version of this split carried a confident, false reason: that a combined
`actions/cache` "saves from the directory state it captured", so minimisation running
before its post step would not reach the stored copy. That is not how the action works —
its post step re-globs and tars `path` from disk at post-job time, and only the key and
exact-hit flag are carried forward in state. cmin's result *would* have been captured.

The review caught it, and it is the more useful half of this log: a wrong mechanism
written confidently into a comment outlives the person who wrote it, and the next
maintainer inherits it as fact. The split survived; the reasoning for it was replaced with
reasons that hold — an explicit save point ordered before the artifact upload rather than
an implicit post-job step, and no exact-hit save-skip to reason about.

`cmin` is not cosmetic. Without it the corpus only grows, and a corpus that outgrows the
cache entry limit silently stops being restored — which returns the lane to the exact
cold-start behaviour this change exists to end, with nothing announcing that it had.

That rationale rests on cmin *replacing* the corpus rather than merging alongside it, and
review rightly flagged that as an unverified premise — if cmin left the originals in place
the corpus would still grow monotonically and the size guard would not exist. Checked
against cargo-fuzz's `exec_cmin` rather than assumed: it merges into a temp dir with
`-merge=1`, and then, **only** `if status.success()`, does
`fs::rename(&corpus, tmp/"old")` followed by `fs::rename(tmp/"corpus", corpus)`. So the
directory is replaced, a failed cmin leaves the corpus intact rather than emptied, and the
two-rename swap is precisely why a cancellation landing between them can leave the
directory absent — which is what the `!cancelled()` gate exists for.

The key is `fuzz-corpus-${{ github.run_id }}-${{ github.run_attempt }}` with
`restore-keys: fuzz-corpus-`. The run-scoped key never hits on read; the prefix falls back
to the most recent entry. A constant key would look simpler and freeze the corpus at
whatever the first run saved, because GitHub cache entries are immutable per key. The
`run_attempt` half arrived later, from review: `run_id` alone is stable across attempts,
so re-running the job from the Actions UI hit the already-reserved key and
`actions/cache/save` warned and continued — green, while that attempt's corpus was
dropped.

Both trailing steps are gated `!cancelled() && steps.corpus-cache.outcome == 'success'`.
A crash in one target still leaves the other four with a run's worth of coverage, so a red
fuzz step must not stop them — but neither condition is the obvious `always()`, and the
second one is the interesting half.

`!cancelled()` is not enough on its own, because **it is true when an earlier step
failed**, not only on a clean run. Ten steps precede the restore, several network-bound
(the repo already carries #4163 because apt mirrors fail here). If one of them fails, the
restore and fuzz steps are skipped — while these two, carrying their own `if:`, run
anyway. cmin finds no manifest and exits 0, and the save then publishes a `corpus/`
holding only what `git checkout` put there. Since `restore-keys` returns the most recently
*created* prefix match, every later run inherits that seeds-only entry.

One flaky apt mirror would have permanently reset the corpus lineage, through a log that
reads normally — the exact failure this change exists to end, reintroduced by the fix for
it. Gating on `steps.corpus-cache.outcome == 'success'` closes it: `== 'success'` rather
than `!= 'skipped'`, since the latter also passes when the restore ran and *failed*, and
an absent step evaluates to `''`.

This was a review catch, not a local one, and it is the second time on this change that
the thing needing correction was a confident sentence rather than a line of code.

## The list that was about to become a third copy

The first draft of the minimisation step hardcoded
`for target in snapshot_decode deeplink_parse import_parse fts_strip html_parse`. That
would have been the **third** copy of the target list, after the `[[bin]]` entries in
`src-tauri/fuzz/Cargo.toml` and the `targets=(...)` array in the run step above it.

The cost of a stale copy is already recorded in this repo: #2945 added `fts_strip` and
`html_parse` to the manifest and not to the workflow, and they were built but never fuzzed
for three months while the lane reported success. Adding a third place to forget, in the
same file, while fixing a different silent-green problem, is not a trade worth making.

The step now reads `fuzz-status/targets.txt` — which the fuzz step already writes for the
`file-fuzz-findings` triage job — and falls back to skipping cmin (rather than guessing)
when the fuzz step died before writing it.

## Seeds for the three targets that had none

Seventeen, chosen to land on distinct branches rather than to be numerous — nested bullets,
task states with SCHEDULED/DEADLINE, page properties, front matter and a truncated fence
for `import_parse`; markup, FTS operators, an unbalanced quote and non-ASCII for
`fts_strip`; full metadata, a login form, a meta-refresh redirect, a relative favicon and a
truncated head for `html_parse`. Each target also gets an `empty.seed`.

These are the floor on a cache miss, not the working set. The point of the cache is that
they stop being the whole story after the first run.

## What is verified, and what cannot be

The lane needs nightly plus an ASan build, so it does not run here. What was checked
locally: all 17 seeds decode as UTF-8 (all three targets take `&str` and discard invalid
input, so a non-UTF-8 seed would be a wasted corpus entry); the manifest-driven loop
enumerates all five targets from a real `targets.txt`; the missing-manifest branch exits 0
rather than looping over nothing. `prek` passes on the workflow, zizmor included.

What cannot be checked here is the thing the issue actually asks for — that the corpus
**grows across two consecutive scheduled runs**. That is deliberately not something this
session can claim.

The criterion also needed correcting, and the review is what corrected it. Reading it off
the `fuzz-artifacts` **file counts** is wrong: the artifact is uploaded after cmin, and
cmin legitimately shrinks the count while preserving coverage — most visibly on the first
run, which minimises the committed seeds. Two successive Mondays can show a flat or
falling count on a lane working exactly as intended.

The evidence to read instead, both now emitted by this lane:

- the `cmin <target>: <before> -> <after>` lines — a rising `after` across runs is
  accumulation, and a `before` that never exceeds the seed count is a restore that is not
  happening;
- the warm/cold line from the restore step, which names the cache entry inherited, or says
  plainly that none matched.

A criterion that can read as failure on a healthy lane is worse than no criterion, because
it gets checked once and believed.
