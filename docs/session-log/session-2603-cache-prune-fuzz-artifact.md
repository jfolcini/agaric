# Session 2603 — main prunes superseded Rust caches, and the fuzz corpus is an artifact

Steps 1 and 2 of #5853's cache map.

- **`cache-prune`** (`ci.yml`, after `validate`, `build` and
  `android-build`, `main` only, `actions: write` on that job alone): for
  every `v0-rust-` family it keeps the newest `refs/heads/main` entry and
  deletes the rest, PR copies included. No family list to maintain: every
  Rust `save-if` is main-only. Two prunes can run at once (one concurrency
  group per commit on `main`); each deletes only entries older than one it
  listed itself, so neither can delete a family's newest entry. A key that
  does not parse as `<family>-Linux-x64-<env>-<lock>` stops the job before
  any delete, because a misread family could merge two families. A failed
  list or delete is a warning; an entry already gone is fine.
  `mutants-merge` deletes `rust-mutants` when the shards finish: next week's
  run never reads it.
- **Fuzz corpus:** the cache keep-alive was losing it anyway (nothing found
  on 10-08 or 10-15), so it is a `fuzz-corpus` artifact kept 90 days. The
  fuzz job restores the newest unexpired one from a `main` run, found by
  artifact name rather than by a successful run, because a run with a
  crashing target still saves its corpus. A failed lookup fails the restore,
  so the run uploads nothing instead of overwriting the lineage with seeds.
  `fuzz-corpus-refresh.yml` is gone, with its `WATCHED` entry.

Dry run of the prune's jq against the live `gh cache list`: it selects
only the superseded `rust-android` generation (1.3 GB); four made-up
entries (an older main generation, a PR copy, a PR-only family, a tie on
`createdAt`) each went the right way, and a macOS key stopped it with
nothing deleted. A fake `gh` exercised delete, already-gone, HTTP 500 and a
failed listing. The maintainer approved the two `.github/AGENTS.md` rules.

The next fuzz run starts from the seeds, with a warning: there is nothing
cached left to carry over.
