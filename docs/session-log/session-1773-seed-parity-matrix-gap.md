# Session 1773 — the seed-parity guard promised a matrix row it never checked for

Follow-up to the sweep that merged #5078, #5079, #5081, #5083 and #5080. Its
non-blocking notes were three: #5081's missing matrix row, and two from #5080.
Only the first earned a change; the reasoning for the other two is recorded
below rather than acted on, because a note whose premise is already satisfied
should not produce churn.

## What was wrong

`resolve-store-title-seed-parity.test.ts` has two tiers: a behavioural matrix
that pins the VALUE each writer stores, and an enumeration guard that scans the
source tree so a new writer cannot appear unregistered. The guard's failure
message told an author that a `seed` writer "must call `resolveStoreTitle` …
AND get a row in WRITERS above". The first half is enforced — a counted check,
gate calls against declared seed writes. The second half was not enforced at
all.

#5075 added `BookmarksSection.tsx` as the newest seed writer and it landed with
the gate call and no matrix row, which is exactly what an unenforced promise
buys. Enforcing the missing direction turned up three more that had been in the
same position for longer: `TrashView.tsx`, `UnlinkedReferences.tsx` and
`use-embed-target.ts`.

## What shipped

`BookmarksSection` gets a real matrix row, driven by writing the
`starred-pages` preference and rendering the component. Only `page` is
declared: the bookmark list holds page ids, so no other block type reaches
that writer.

The cross-writer convergence block seeds ONE id with several writers in turn,
and a cache-gated writer seeded second writes nothing — its assertion would be
vacuously true. `useBacklinkResolution` already had that problem and was kept
first by a `name.startsWith('useBacklink')` sort, which stopped identifying the
class the moment a second cache-gated writer existed. That is replaced by a
declared `cacheGated` flag and a partition that admits exactly one such writer
as the leader. `BookmarksSection` therefore sits out convergence deliberately;
it costs nothing, because every matrix row is pinned against the same literal,
so agreement follows transitively, and a writer that declines to write cannot
churn `version`.

The considered alternative — give a cache-gated writer its own fresh id inside
the convergence block — was rejected as a second copy of an assertion the
matrix row already makes. Convergence's unique contribution is the `version`
check, and that needs the shared id a cache-gated writer cannot be driven with.

The missing direction is now a test: a declared `seed` writer has a matrix row
or is named in `SEED_WRITERS_WITHOUT_MATRIX_ROW`, whose docblock states what
the omission costs (the counted gate check proves the call; only a matrix row
proves the value). The three long-standing gaps are named there rather than
given harnesses this change did not need. The guard's failure message now says
what it actually checks.

`block-title.ts` carried a second, hand-maintained list headed "The writers
(all of them)", and the module docblock said the enumeration was "written down
here and pinned by a test". The test pins `DECLARED_WRITERS`, not that prose,
so the list read as pinned while nothing checked it — and it had silently
drifted twice, missing `use-embed-target.ts` (#4550) and `BookmarksSection`
(#5075). Deleted in favour of a pointer to the enforced table, rather than
corrected a third time.

## The two #5080 notes: neither needs code

**The unconditional `RebuildAgendaCache` boot enqueue** (`src-tauri/src/repair.rs`).
The note asked whether it should be gated once it has shipped a version. The
comment already states the reason and it is the right one: #5074 changed
`DESIRED_AGENDA_SQL` but nothing rewrites rows already in `agenda_cache`, and
the diff runs only when a task enqueues it. A vault whose repairs find nothing
is precisely the one whose stale agenda rows would otherwise never clear, so
gating on a repair having fired would reintroduce the hole. Left alone.

**`GROUP_ORDER`'s `DONE` arm** (`src/components/agenda/DuePanel.tsx`). Recorded
as decided across three reviews. Re-reading it confirms the decision: `DONE` is
not a hand-written arm at all — `GROUP_ORDER = [...TASK_STATE_SORT_ORDER, null]`
— so dropping it means forking the shared task-state order for one panel. The
header counts `visibleBlocks.length` while rows come from `GROUP_ORDER`, so a
missing state hides rows that still count (the #738 desync), and an always-empty
group is dropped by the `items.length > 0` filter anyway. It costs one unused
label. Left alone.

## Verified

Both directions were shown red against a copy, restored, and `cmp`-checked:

- Deleting the `BookmarksSection` row from `WRITERS` reddens the new
  enforcement test, naming the file.
- Bypassing the gate in `BookmarksSection.tsx` for non-null titles — chosen so
  the `resolveStoreTitle` call stays present and the counted-gate check stays
  green, isolating the matrix as the thing that catches it — reddens
  `block_type=page × blank` (`'' ` vs `Untitled`) and
  `block_type=page × whitespace only` (`'   '` vs `Untitled`). Reproduced
  independently of the agent that wrote it.

`npx vitest run resolve-store-title-seed-parity.test.ts BookmarksSection.test.tsx`
→ 2 files, 163 passed, 51 skipped. `npm run typecheck`, `oxlint` and
`oxfmt --check` clean on both touched files.
