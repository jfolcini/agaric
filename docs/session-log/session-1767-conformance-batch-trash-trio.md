# Session 1767 — #5057: the trash-lifecycle batch trio

Continuing the #5057 burn-down. The previous session shipped the drafts cluster
(#5064, five commands, 42 → 37). This one takes three more.

## What it set out to do

Pick the highest-value cluster left. The batch-ops group is the largest (eight
commands) and, on paper, the cheapest: everything it writes lands in `blocks`,
`block_properties` and `block_tags`, all of which the #763 snapshot already
covers, so no snapshot widening was expected.

It split naturally by return shape, and only the first third is in this session:
`delete_blocks_by_ids`, `restore_blocks_by_ids` and `purge_blocks_by_ids` all
answer with a count envelope, so they needed no harness extension at all. The
other five do — three return a bare `i64` and two return arrays, neither of
which `project_return` can express today — and are left for the next session.

## What it found

All three were waived as "batch of <single-block command>". That premise is
wrong, and the fixture that replaced it exposed five defects.

Three in the mock, none of them reachable while the commands were waived:

- `restore_blocks_by_ids` cleared `deleted_at` only on the ids passed in, so
  restoring a subtree root left its descendants tombstoned underneath a live
  parent. Its own single-block sibling already called `restoreCohort`; the batch
  variant was strictly less faithful than the handler next to it.
- `purge_blocks_by_ids` appended **no op at all**, so a batch purge was invisible
  to the op log, and it counted only the listed ids rather than the subtree it
  actually destroyed.
- Neither batch handler rejected an empty list, which the backend refuses with
  `AppError::Validation` on all three paths.

Two in the harness, and these are the more interesting ones, because both made
the batch leg *silently inert* rather than red:

- `expandOpArgs` in the TS replay resolved only scalar id args (`blockId`,
  `parentId`, `newParentId`, `tagId`). A `blockIds` **list** was passed through
  untouched, so the mock received raw fixture labels, matched no block, and every
  batch op degenerated into a no-op that still satisfied its own guards. Any
  batch fixture written before this fix would have passed while proving nothing.
- The #891 SQL/Loro parity guard learns which parent groups a purge leaves
  position-gapped from the op-type switch in `replay_fixture`, which knew only
  the single-block `purge_block`. The batch variant produces an identical gap and
  was not recognised, so the fixture failed parity before any comparison ran.
  `read_structural_op_parent` now reports row presence in its outer `Option` —
  a missing id is a fixture bug for the single-block commands and legal for the
  batch purge, whose backend skips it — and a batch purge contributes every
  listed root's parent group.

One thing the fixture corrected in this session's own understanding: a restore
that walks up a tombstoned ancestor chain **does** revive the ancestors, but
`affected_count` does not count them. The first draft of the fixture comment
asserted the count would include them. The backend-authored `expected` said
`affected_count=1` while the settled snapshot showed the ancestor live, so the
comment was rewritten to state the asymmetry instead. Both arms are now pinned:
the op above it restores a cohort and the cohort *is* counted.

## What shipped

One commit on `claude/main-fix-pr-merge-mvbujf`, PR opened off it.

`conformance/fixtures/batch_trash_lifecycle.json` drives all three commands
through the command leg (#4670) over a nine-block seed: a delete that cascades
down three levels, a delete whose root is a page (so `affected_page_ids` is
non-empty), a delete that skips an already-tombstoned id, a cohort restore, an
ancestor-chain restore, a purge that cascades to descendants while appending one
op per root, and the empty-list and live-block refusals all three share.

The single-block purge's descendant walk moved to `collectPurgeCohort` so both
purge handlers share one walk rather than carrying two copies.

`MUTATING_ARM_COUNT` 8 → 11. `NOT_YET_PINNED_MUTATING` and `NO_FIXTURE_ALLOWLIST`
each lose the same three names. Debt 37 → 34.

## What was verified

Every fix was falsified against a copy and restored byte-identically (`cmp`),
per AGENTS.md § Acceptance is falsification. Seven mutations, seven reds:

| Mutation | Result |
| --- | --- |
| restore uses the listed id instead of the cohort | red — `affected_count` 3 → 1 |
| purge drops its per-root op | red — op-log digest |
| purge counts roots instead of the cascade cohort | red — `affected_count` 2 → 1 |
| purge drops the empty-list guard | red — declared refusal did not fire |
| restore drops the empty-list guard | red — declared refusal did not fire |
| replay drops the `blockIds` label expansion | red |
| parity guard forgets `purge_blocks_by_ids` | red — #891 position gap |

That sixth row is the one worth keeping: without the expansion fix the fixture
passes while driving nothing, which is exactly the shape AGENTS.md calls a test
that cannot fail.

Suites actually run:

```
cargo nextest run --workspace -E 'test(conformance) or test(structural_op_parent)'
                                  107 passed, 6237 skipped
npx vitest run src/lib/tauri-mock  45 files, 896 passed
npm run typecheck                  clean
npx knip                           no unused exports
```

## Next

The remaining five batch commands need the command leg to express two return
shapes it cannot today: a bare scalar (`set_property_batch`,
`set_todo_state_batch`, `add_tags_by_ids` all return `i64`) and an array of rows
(`create_blocks_batch`, `move_blocks_batch`). A scalar currently falls through
`project_return`'s `as_object().unwrap_or_default()` to an empty object, so it
would pin the command name and silently drop the count — a latent trap for any
future scalar-returning command wired as `HEADED_ID_KEY`, not just these three.

Also worth recording against #5057: its cluster table enumerates 24 of the 34
mutating commands still in debt. The sync/peers group (`cancel_pairing`,
`confirm_pairing`, `delete_peer_ref`, `set_peer_address`, `update_peer_name`)
and a misc group (`delete_property_def`, `fetch_link_metadata`,
`quick_capture_block`, `set_page_aliases`, `set_reminder_settings`) are real debt
the issue does not name.

The spaces cluster remains blocked on the per-space Loro registry, as written up
on #5057 last session — unchanged here.
