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

## Three steps, and why it is not one

`actions/cache` restore-and-save in a single step would have been shorter and wrong. The
combined action saves at post-job, from the directory state it captured, so a minimisation
pass running before it has no effect on what gets stored. Split into
`cache/restore` → fuzz → `cargo fuzz cmin` → `cache/save`, the saved corpus is the
minimised one.

`cmin` is not cosmetic. Without it the corpus only grows, and a corpus that outgrows the
cache entry limit silently stops being restored — which returns the lane to the exact
cold-start behaviour this change exists to end, with nothing announcing that it had.

The key is `fuzz-corpus-${{ github.run_id }}` with `restore-keys: fuzz-corpus-`. The
run-scoped key never hits on read; the prefix falls back to the most recent entry. A
constant key would look simpler and freeze the corpus at whatever the first run saved,
because GitHub cache entries are immutable per key.

`if: always()` on both trailing steps: a crash in one target still leaves the other four
with a run's worth of coverage, and letting one red target reset every sibling's corpus
would be a worse failure than the one being fixed.

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
**grows across two consecutive scheduled runs**. That is the acceptance criterion, it is
observable in the `fuzz-artifacts` file counts on two successive Mondays, and it is
deliberately not something this session can claim.
