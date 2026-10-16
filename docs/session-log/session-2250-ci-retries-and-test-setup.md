# Session 2250 — Playwright stops retrying, and faster vitest setup

The maintainer approved three cheap CI fixes from a CI survey and turning
off Playwright's retries.

**Retries off.** `playwright.config.ts` retried once in CI and twice
locally. About 19% of passing CI Playwright jobs between 2026-10-01 and
10-16 needed that retry, which hid the flakes the last few PRs fixed. It is
now 0 everywhere. The local reason no longer holds, because the pre-push
gate does not run Playwright. The comments that described the retries are
corrected, and so is `e2e/AGENTS.md`'s reproduction line, with the
maintainer's approval.

**Vitest setup.** Test setup imported the `date-fns/locale` barrel through
`src/lib/i18n/locales.ts`, which cost about 1.4 s of every test file's start.
Each import now names its locale (`date-fns/locale/en-US`, `…/es`). A trivial
test went from 1.28 s to 0.54 s. Run in the foreground on a loaded box, one
full shard went from 133 s to 79 s wall time, and its CPU time halved.

**TrashView.** Four tests rendered 1001 trash rows only to make
`purgeAllDeletedInSpace` and `restoreAllDeletedInSpace` chunk past
`MAX_TRASH_BATCH_IDS`. #3885 had added 60 s timeouts. Now a second listing
page that only the helpers' cursor walk reaches carries the extra ids, and
one row renders. The file went from 24.9 s to 9.5 s, and the timeouts are
gone. Each test was shown red by breaking the partial branch, the announce
count, the cache invalidation, the chunking or the cursor walk.

**Checked, not changed:**
- **Vitest shards.** Vitest hash-sorts files before slicing, so a shard
  holds no run of heavy files. The slow shard changed from run to run, and
  one shard's time ranged from 285 to 540 s, so the spread is runner
  variance.
- **The build job's timeout.** Its 47 min run (37757471200) was a 19 min apt
  mirror stall on top of a cold Rust cache. A cold build takes about 30 min,
  under the 50 min cap.
