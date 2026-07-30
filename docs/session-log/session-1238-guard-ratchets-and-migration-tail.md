# Session 1238 — guard ratchets, layering direction, migration tail

`/loop /batch-issues` run, 2026-07-30. Continues session 1237, which covers the same day
through migration phase 9.

## Ratcheted guards

Two guards were widened or added; both are two-sided ratchets (a NEW violation fails, and
a STALE baseline entry also fails) with `--self-test` fixtures.

- **#3196 — the tauri-import ratchet was blind to submodule paths.** The matcher was
  `/from\s*(['"])@\/lib\/tauri\1/`: the backreference forces the closing quote immediately
  after `tauri`, so every `@/lib/tauri/<domain>` import was invisible to it. The migration
  had been redirecting call sites into submodules and the baseline was counting that as
  progress. Widened to cover static, dynamic and side-effect imports of the submodules,
  excluding the shim itself; added `scripts/tauri-sanctioned-symbols.json` so the three
  legitimately-direct symbols (`readAttachment`, `ensureNotificationPermission`,
  `startSync`) are named rather than tolerated by silence.

  **Correction on the record:** the first read of this was that the submodule redirects
  were substantively legitimate and the ratchet simply hadn't been taught about them.
  Adversarial review refuted it — all nine prior migration commits added zero submodule
  imports, and the one file the widened guard caught (`src/lib/list-style.ts`) was a
  pre-existing leak, not precedent. The honest phase-9 number is 77 → 69, not 77 → 66.

- **#3121 — nothing enforced frontend layer direction.** Added
  `scripts/check-lib-layering.mjs` (`lib < stores < hooks < components`), reusing
  `detectImports` from the cycle checker. Baseline 22 → 20 after moving
  `PageFilterWithKey` into `src/lib/filters/` (#3203), which was the single reason stores
  imported from components.

  Review caught that `runGuard()`'s `process.exit(1)` had zero coverage and `prek.toml`'s
  glob would not have caught the regression; the self-test now shells out to the CLI and
  asserts exit codes (2 missing baseline / 0 clean / 1 new violation).

## Migration phases 9 and 10

`tauri.ts → bindings.ts` (#2927) phases 9 and 10 landed: attachments, peers, sync,
notifications, then counts, boot recovery and MCP. Baseline 77 → 61 across the day. What
remains is concentrated in the OS-plugin shims, split out as **#3202**.

## #3160 — the 100K agenda projection

`list_projected_agenda` was falling back to a full expansion. Three defects here, and the
review verdict on the first submission was **do-not-ship**:

- The empty-result probe treated "cache returned nothing" as "cache is cold", so any query
  window with genuinely no entries forced a rebuild. It now requires the query range to sit
  inside the cache's proven span, and the rebuild's reference date (new nullable
  `rebuild_today` column, migration 0105) to equal the reader's today.
- `projected_agenda_horizon` was missing from the snapshot-restore `CACHE_TABLES` wipe, so
  a restore could resurrect a horizon claim for data that no longer existed.
- Migration 0104 adds the covering index `(projected_date, block_id, source)` and drops the
  now-redundant prefix index.

**The benchmark never executed the path it documented.** The fixture seeded every
recurrence base in the future relative to the measured window, so the "100K rows" case was
measuring an empty scan. Bases are now seeded in the past and the permanent assertion page
returns `min(size, 200)`.

**On measuring at all:** an earlier attempt tried to establish the regression by
wall-clock on a box running four concurrent agents. That cannot produce a signal and the
approach was dropped in favour of `EXPLAIN QUERY PLAN` structural evidence.

## #3172 — closed with caveats

The repo already has `allow_auto_merge: true`, so auto-merge is *available*; no workflow
was added to enable it per-PR, deliberately, since that is a CI change of its own. Note
that `require_last_push_approval: true` with a solo maintainer means the maintainer's own
PRs still need `--admin` regardless of auto-merge.

## Mutation survivors

**#3142** — 21 survivors killed across `agenda-sort`, `search-query` and `classify`. One
"equivalent mutant" verdict in the inherited analysis was wrong and was killed rather than
accepted.

## Notes

- **#2003 was picked from its body alone and was already shipped** — all three scope items
  were done. The comment thread said so. Reading the thread, not just the body, is the
  rule this violated; what shipped from it (#3200) is a genuine test-coverage gap found
  while confirming the issue was stale, not the issue's own scope.
- One builder breached the no-git constraint with a single `git checkout --` on a
  production file. Self-disclosed; the production files were verified byte-identical.
- Three pre-commit aborts masked as success (`oxfmt` reformat, `unicorn/no-array-sort`,
  `unicorn/prefer-import-meta-properties`). HEAD did not advance in any of them. Confirming
  `git log --oneline -1` after every commit is not optional.

## Issues filed

#3194, #3196, #3202, #3206.
