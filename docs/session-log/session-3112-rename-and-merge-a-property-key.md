# Session 3112 — Rename a property key and merge one into another (#5841 S2)

Slice S2 of #5841, built on S1 (#6187). The maintainer decided its four open questions in issue comment 6504560322:
- undo follows renames and merges made on other devices;
- merge's *from* must be a declared key;
- merge counts include the Trash;
- internal keys are refused on both sides.

Merging keys of different types is refused (earlier answer Q3).

**Shipped:**
- **Two ops,** both keyed to the space (`op_log.block_id` is the space id), with no format bump:
  - **`rename_property_key { space_id, old_key, new_key }`** moves every value and the definition in the space doc and in SQL. It moves a value only where the new key is absent, so a boot replay leaves a later write under the old key alone.
  - **`rewrite_properties { space_id, reason: merge, defs, values }`** holds absolute writes, so undo is a swap. S3 adds `change_type` to the reason.
- **Commands:** `rename_property_key`, `preview_property_merge` and `merge_property_key` (in `commands/property_keys.rs`). A stale merge acknowledgement is refused with `UnacknowledgedPropertyLoss`, and merge reads holders from SQL, as its preview does.
  - Rename refuses a target that is built in, internal, declared, or used on any block of the space (Trash included).
  - A block holding both keys keeps *into*, and undo restores its *from* value.
  - A select's options are the union of both keys' options.
- **Undo follows the key.** The design put this bug in `find_prior_property`. That premise was wrong: every live writer records its `prior`, so the lookup only serves older ops. The real bug was the reverse op's key.
  - **The fix:** `with_recorded_prior_in_tx`, which every undo, revert, page-undo, redo and restore path goes through, forwards a set's or delete's key through the space's later renames and merges (`forward_property_key`).
  - **How it walks:**
    - A rename swaps its two names. A rename's target is always unused, so a key equal to the target names a value that is gone.
    - A merge's per-block writes are read as a move in or a move out. A move out is followed unless a move in came first.
  - **The plan's rule was wrong twice:**
    - **"Removed value equals written value"** lost data when a delete and a merge into the same key were undone together. The builder's proptest found it.
    - **"Rename only follows `old_key`"** overwrote a live value once a rename reused a name an earlier op had used. The review found it with a wider fuzz. The builder's proptest had missed it because its oracle copied the production rule. The proptest now reuses names, writes undeclared keys, and checks against an independent cell model.
- **Settings › Properties** gets Rename and *Merge into…*, each with an Undo toast. The merge dialog shows the counts, notes the Trash, and previews again on a stale acknowledgement. History labels both ops.
- **Rename pre-flight.** `renameMayDeclareKey` now probes `queryByProperty` in the space instead of the vault-wide key list (a carry-over from session 2855).
- **`INTERNAL_PROPERTY_KEYS`** has a Rust mirror in `op.rs`, pinned by a parity test.
- **Mock.** The mock mirrors all of this and is pinned by five new fixtures.

**Accepted:**
- **A merge payload is large.** It holds two absolute writes per moved value, about 2.6 MB at 10K values. Each undone set or delete parses every later merge payload of its space. The review measured about 76 ms for a 100K-value merge, which matters only for a large batch undo after a large merge.
- **A merge leaves a hidden value hidden.** A value under *from* that SQL hides, such as a ref to a purged page, moves and stays hidden.
- **The two-device outcome of a concurrent rename depends on merge order.** A value written under the old key at the same time as the rename may stay under that key or be lost to the rename.

**Ran:**
- **clippy:** clean.
- **Full nextest (before the review fixes):** 3635 + 3630 passed, plus doc-tests.
- **After the review fixes:** 581 targeted Rust tests, plus clippy again.
- **Full vitest:** 23,977 passed.
- **The whole Playwright lane:** 1,573 passed. Its only failures are the two `diagram-legibility` cases, which fail the same way on `main` in this container.
- **`prek` manual stage:** passed.
- **Not run here:** `e2e-tauri/property-key-rename.e2e.ts`, which runs in CI.
