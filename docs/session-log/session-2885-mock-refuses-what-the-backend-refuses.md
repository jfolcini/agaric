# Session 2885 — the mock refuses what the backend refuses, and the fuzzer compares return values (#6054 A, B1)

#6054's first PR. The maintainer's direction (2026-10-22) is for the tauri mock to really match the backend. Before this, a mock-lane spec could stay green where the real app shows an error, because the mock accepted what the backend refuses. The differential fuzzer compared only final snapshots, so it never saw a refusal.

**Phase A: the mock refuses the same way.** Each refusal has a backend-authored fixture, and the mock was changed to match it.

| What the mock now refuses | Fixture |
|---|---|
| `delete_property` on a missing or trashed block | `delete_property_inactive_block` |
| `create_block` with a client id that collides with an existing block | `create_block_client_id_collision` |
| `list_journal_pages_in_range` with a bad date or `start > end` | `query_journal_pages` |
| `query_by_tags` and `list_all_pages_in_space` over the tag-filter cap | `query_tag_filter_cap` |
| cross-space `add_tag` | `add_tag_cross_space`, `add_tag_page_in_another_space` |
| `add_tag` of an applied tag, `remove_tag` of an unattached one | `tag_add_remove` |

Notes on the table:
- The client-id fixture also pins #5691's client-id create: the block answers to its client id.
- #6054's body names the tag-filter command `list_blocks_by_tags`; that command does not exist, and the two above are the ones the cap guards.
- `tag_add_remove` was restructured so the mock can be strict while the fixture keeps what it pins.

**Phase B1: the fuzzer compares what each command returns.** `conformance_fuzz` now compares each command's return value and error kind and code, not just the final snapshot, and the generator emits invalid commands among valid ones:
- missing or deleted ids;
- colliding client ids;
- bad dates;
- cross-space targets.

The divergences it found are fixed and pinned:
- commands on inactive blocks (`commands_on_inactive_blocks`);
- `move_block`'s returned rank (`move_block_returns_provisional_rank`);
- `set_property` with an invalid date (`set_property_invalid_date`);
- a non-page root owning itself in the seed loader.

**The weekly fuzz lane was red on main.** The generator set `priority` to arbitrary strings. Since S0.1 locked the built-in, the command path refuses them, and so does the mock. The backend applied them only through payload replay, which skips command validation. The generator now draws `priority` from `PRIORITY_LEVELS`, and `every_generated_set_property_passes_command_validation_4679` checks each generated value against its key's built-in definition.

**Also:** the `undo_todo_state_batch` fixture, left over from #6071, pins that an undo of `set_todo_state_batch` restores each block's prior state.

**Recovery.** The first builder stopped unfinished, and a container restart killed the second mid-task. The third reviewed the inherited diff before finishing:
- it diffed the falsification backups against the tree;
- it re-authored every fixture from the backend and restored the reformat-only ones;
- it checked `MUTATING_ARM_COUNT` = 55 against what the test counts.

**Shown red,** each with a one-command mutation of the mock that restored the file. Every item above failed on the mock leg with the predicted error. For the generator, removing the `priority` routing failed with "value … is not in allowed options: 1, 2, 3". Reverting the `move_block` rank fix made the fuzzer shrink to a 2-op counter-example identical to the committed fixture.

**Suites:**

| Suite | Result |
|---|---|
| fuzz lane, 256 cases (the weekly default) | 35 s, no divergence |
| fuzz lane, 1024 cases | 146 s, no divergence |
| Rust `test(conformance)` and the arm-count test, after rebasing over S0.6 | 108 passed |
| `command_integration` | 342 passed |
| generator-sharing proptests | 58 passed |
| vitest `src/lib/tauri-mock` and `src/lib/__tests__`, after the rebase | 184 files, 4647 passed |

clippy `-D warnings`, `SQLX_OFFLINE=true cargo check`, typecheck and lint were clean.

The whole Playwright lane ran in 12 shards. No spec relied on the mock's leniency. These fail the same way with the base mock in this container and pass in CI: `block-line-break.spec.ts:292`, `diagram-legibility.spec.ts:144`/`:380`, and the three PDF specs, on Chromium's missing `getOrInsertComputed`.

**Deferred to later #6054 PRs:**
- B2–B5: bracket tokens in content, `SetProperty(space)` and cross-space moves, the read surface, attachments;
- C (events) and D (the deliberate gaps);
- the mock's `add_tag` checking that the tag is a `tag` block, which needs the payload-replayed fixtures moved first;
- `restore_block` checking `deleted_at_ref`.
