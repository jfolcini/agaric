# Session 1237 — sync replay gate fixpoint, agenda CANCELLED token, migration phase 9

`/loop /batch-issues` run, 2026-07-30.

| | |
|---|---|
| **Date** | 2026-07-30 |
| **Subagents** | 3 build + 3 review |
| **Items closed** | #3184, #3188, #3189 |
| **Items modified** | #3142 (partial), #2927 (phase 9) |
| **Items filed** | #3194, #3196 |
| **PRs** | #3193 (merged), #3195 (merged), phase 9 |

**Summary:** Fixed two boot-replay gate defects that discarded recoverable sync data, gave
the CANCELLED agenda group the status token it was missing, and advanced the `tauri.ts`
migration ratchet 77 → 69. Adversarial review earned its cost twice: it killed a tautological
assertion and a false safety claim in the sync work, and it caught the migration slice
removing three files from the ratchet baseline without actually migrating them.

## Sync boot-replay gate (#3188, #3189 → PR #3195)

Two complementary defects in `gate_replay_blobs`
(`src-tauri/agaric-engine/src/loro/engine/sync.rs`), both surfaced by the #3164 review.

**#3188 — single forward pass.** A blob whose causal dependency arrived *later in the same
batch* was reported unreachable and its inbox slot dropped, even though `import_batch` would
have resolved it (loro buffers unmet deps in `pending_changes`). The gate is now two-phase:
one sweep decides forks and parks decoded metadata, then repeated passes grow the cumulative
base until a pass accepts nothing new. Metadata decodes once per blob — the decode rebuilds
the blob's change store, so the quadratic part is cheap comparisons, not decodes.

**#3189 — cross-peer dependencies unchecked.** The gate compared only `partial_start_vv`,
which records a blob's *own-peer* counter range. Cross-peer deps live in
`ImportBlobMetadata::start_frontiers`, so such a blob passed the gate, landed in
`pending_changes`, never advanced the oplog, was never projected — and its slot was deleted
anyway. A #535 violation in the silent direction.

They ship together because the fixpoint is what keeps the stricter cross-peer check from
dropping a slot whose dependency is merely sitting later in the batch.

**Counter semantics were derived, not assumed.** Against the pinned `loro-internal 1.13.6`:
`Frontiers` counters are inclusive last-op ids, `VersionVector` counters are exclusive ends,
so a dep is covered iff `base[peer] >= counter + 1`. The `partial_start_vv` half deliberately
uses `>= counter` because *that* field is an inclusive start — the asymmetry is correct, not
an off-by-one. Both directions of getting this wrong are silent data bugs, so the derivation
is recorded in the code with citations.

The reviewer also established the #3189 narrowing is well targeted rather than blunt: loro
pushes a dep into `start_frontiers` either when its peer is in the blob but starts later
(already implied more strongly by `partial_start_vv`) or when the peer is absent entirely.
Only the second case is newly rejected — precisely the hole.

### Two review findings on the first cut

- The claimed property `batch ⊇ per-row` is **false**. #3189 makes the batch gate *stricter*
  on cross-peer deps than the per-row guard — contradicted by the PR's own
  `..._rejects_unmet_cross_peer_dep_3189` test. Replaced with the correctly-scoped property:
  the fixpoint accepts a superset of the single forward pass *under the same predicate*.
- The one-sided-divergence assertion was a **tautology** — a preceding `assert_eq!` forced
  its condition true, so it could never fire. Documentation cosplaying as a test. Removed;
  the per-row verdicts are retained as a precondition so the batch assertion can't go vacuous.

### Tests

Renamed and re-pinned `gate_replay_blobs_matches_per_row_on_out_of_order_batch_3164_review`
(the fixpoint intentionally diverges from what it pinned). Added: dep-arrives-later;
unmet cross-peer dep; cross-peer dep supplied by the batch; shallow-snapshot carve-out; and
two **end-to-end** `import_batch` tests proving reversed-order batches actually project —
reading blocks back rather than trusting `Ok(())`, since `import_batch` returns `Ok` with
changes still buffered. Two were mutation-verified: truncating the batch makes `changed`
come back empty, which is the #535 silent-loss shape.

## Agenda CANCELLED token (#3184, #3142 slice → PR #3193)

`groupByState` seeded five buckets but `CLASS_MAP` had four entries, so the CANCELLED group
rendered unstyled. The issue held this pending a maintainer call on which token to use; that
was moot — `text-task-cancelled` already *is* the app's CANCELLED treatment
(`status-icon.tsx:75`, `BlockInlineControls.tsx:121`, `--color-task-cancelled` in
`index.css`), so this extends an existing convention rather than introducing a token.

Closed the #3142 `CLASS_MAP` survivors in the same change. The fixture populates all five
states, so no bucket hits the empty-group skip and the positional assertion pins every entry —
each of the six mutants now fails a specific assertion.

## Migration phase 9 (#2927)

8 files fully off the `@/lib/tauri` barrel; baseline 77 → 69. `DeviceManagement.tsx` and
`NotificationsTab.tsx` had their migratable symbols moved but stay in the baseline, each
still needing one value-adding wrapper.

**The first cut claimed 77 → 66 by redirecting three files from the barrel to
`@/lib/tauri/<domain>` submodule paths.** The three symbols are genuinely un-migratable
(`readAttachment` is a raw `invoke<ArrayBuffer>` with no `commands.*` equivalent, because a
raw-response command can't carry `specta::Type`; `startSync` is Channel plumbing;
`ensureNotificationPermission` is a plugin shim). But keeping the wrapper is not the same as
dropping the file from the baseline — the surviving entries *are* the intended floor.
Reverted in review; `GatedImage.tsx` then reverted byte-identical to HEAD, having contributed
zero migration work.

The justifying "precedent" did not exist: all nine prior migration commits were checked and
**none** added a submodule import in app code.

## Filed

- **#3194** — the replay gate advances its cumulative base by `partial_end_vv` without
  verifying the import reached it, and the caller deletes slots without that check.
  Pre-existing, slightly widened by the fixpoint (an over-claim can now unlock blobs in
  earlier slots too). Caller-side fix, out of scope here.
- **#3196** — the ratchet guard's `STATIC_RE` requires the closing quote immediately after
  `@/lib/tauri`, so submodule imports are unpoliced and the baseline conflates "migrated"
  with "down to value-adding wrappers". This is the completion criterion #2927 notes as
  missing.

## Correction on the record

The #2927 thread states "zero submodule-path mocks exist repo-wide, so a barrel-path regex is
complete". That was already false when written: `src/lib/__tests__/list-style.test.ts:7` has
mocked `@/lib/tauri/properties` since `40ea1c971` (2026-07-24 19:39:34Z), 23 minutes before
the comment (20:02:04Z). The reverse-transitive-closure method used to pick every phase's
batch depends on that regex being complete, so future phases must intersect against both
`vi.mock('@/lib/tauri'` and `vi.mock('@/lib/tauri/`.

## Not taken

- **#3167** (e2e-tauri build time) — already claimed by another session, and explicitly
  blocked pending Monday's first warm-cache run.
- **#3172** (strict ruleset vs. Dependabot merges) — a repo-policy decision (auto-merge vs.
  merge queue vs. relaxing `strict`), not a code change. Hit live again this session: #3195
  went `BEHIND` the moment #3193 merged.
- **#3190** (fork guard order-dependence on an empty doc) — its own fix needs a way to
  distinguish "continues our lineage" from "forks it" that doesn't depend on the doc counter.
  Deliberately left; the safe direction is documented.
- **#3149** (loro 1.13.7) — correctly red and held by #3161.
