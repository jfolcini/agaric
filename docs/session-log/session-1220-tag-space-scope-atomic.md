# Session 1220 — Atomic space-scoped tag creation (#3081)

**Issue:** #3081 (user report: create a tag, switch view, return — the tag is gone)

## Root cause

Tag creation was a **durable orphan create + best-effort scope stamp**: the frontend
created the tag block (committed), then fired a separate `setProperty({key:'space'})`
whose failure was swallowed. `create_block_inner_with_space` threaded `SpaceScope` for
pages only; tags fell through to the legacy orphan create. If the follow-up stamp was
skipped or failed (e.g. the #708 projection-registration gate silently skipping
`blocks.space_id`), the tag existed but `list_all_tags_in_space` (which filters on
`blocks.space_id`) never returned it again.

## Fix

- **Backend** (`src-tauri/src/commands/blocks/crud.rs`): new `create_tag_in_space_inner`
  — validates the target space up front (live block, `is_space='true'`; `AppError::
  Validation` loudly otherwise), then emits `CreateBlock` + `SetProperty(space)` in ONE
  `BEGIN IMMEDIATE` tx, mirroring `create_page_in_space_inner`. `create_block_inner_
  with_space` routes `block_type=="tag"` + `SpaceScope::Active` to it; Global falls
  through unchanged. Validation is strictly stronger than the #708 gate (registry via
  the migration-0089 trigger), so a validated space always projects.
- **Frontend** (4 call sites — TagList, block-tree/use-block-resolve, paste-internalize,
  useBlockTags): pass the active `spaceId` through `createBlock`, drop the swallowed
  `setProperty` follow-up.
- **Mock parity**: `list_all_tags_in_space` filters on `b.space_id` (was: the retired
  `block_properties(key='space')` contract from migrations 0087/0088); create stamps
  `space_id`; `set_property(space)` projects to `space_id`; seed stamps space-scoped
  fixtures.

## Tests (durable re-queried effect, per the #3086 invariant)

- Rust `tag_integration.rs`: `create_tag_in_active_space_is_space_stamped_and_listed_3081`
  (real command path, asserts `blocks.space_id` AND `list_all_tags_in_space` round-trip,
  deliberately WITHOUT `assign_all_to_test_space`) + loud-error rollback test.
- Mock round-trip tests re-query after create; 4 component/hook suites updated to the
  atomic contract.
- No conformance fixture — verified structurally impossible (create op arm carries no
  space scope; `run_fixture` masks orphans via `assign_all_to_test_space`; snapshot
  omits `space_id`). The Rust integration test is the stronger backend proof.

## Review

Adversarial review (independent agent): SHIP-WITH-FIXES. Found one real test-layer
regression — the mock's `load_page_subtree` still reads the legacy `space` property, so
freshly-created tags (now stamping only `space_id`) broke tag-pill navigation in
`tag-management.spec.ts` (3/3 deterministic, base-green). Fixed by dual-writing the
legacy property for created tags (matching the seed's deliberate dual-write); e2e
17/17 after. Flagged for the mock-parity track: `pages.ts` `load_page_subtree` (and
`move_blocks_to_space`) should migrate to `space_id`. Confirmed zero conflict with the
just-merged #3090 (disjoint hunks; `space` not in its reserved-column map).

## Verification

- Post-rebase over #3090: mock suites 18 files / 474 passed; targeted nextest
  (`_3081` + conformance) 3 passed; `tsc -b` 0; oxlint clean; e2e tag-management 17/17.
