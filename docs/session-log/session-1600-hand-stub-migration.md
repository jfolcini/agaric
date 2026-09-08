# Session 1600 — 22 tests were passing through an error branch (#4668)

## What shipped

`src/hooks/__tests__/` migrated onto the typed `mockInvokeCommands` seam — all
13 counted files. Ratchet 85 → 72. `useQueryExecution.test.ts`'s per-file
`vi.mock('@tauri-apps/api/core')` opt-out became unnecessary and was deleted,
pruning `strict-invoke-optout-baseline.json` to 8.

## The finding

`useBlockTags.test.ts` has 34 tests. Instrumenting the hook's `.catch` on main —
`process.stderr.write` from inside the branch, counted across the suite — gives:

```
  2 EB:Error: DB error
 18 EB:TypeError: Cannot read properties of undefined (reading 'filter')
  4 EB:TypeError: inheritedIds.filter is not a function
```

**24 error-branch entries; only 2 intended.** `useBlockTags.ts:122` calls
`listInheritedTagsForBlock`, which returns `string[]`, and `:128` does
`inheritedIds.filter(...)`. Most tests never stubbed that command, so it fell to
a catch-all — `undefined` in 18 cases, the `emptyPage` OBJECT in 4. Either way
the `.then` threw, the `.catch` ran, and the assertions still held because
`setAppliedTagIds` had already landed before the throw.

After migration the same instrumentation prints only the 2 intended entries, and
the same 34 tests pass. That is the whole point: they passed identically either
way, so nothing could have told you.

One test was green for a reason its own name contradicts. `shows toast error
when loading tags fails` names `list_blocks` throwing as the cause, but
`afterEach` resets `currentSpaceId` to `null`, so `list_blocks` was never
called — the asserted `tags-load-failed` toast came entirely from the drift.
Correcting ONLY that one stub on main breaks it, which is how the fiction was
confirmed rather than argued.

## Other drift the typing rejected

Field sets: `get_properties` returned a `block_id` that `PropertyRow` does not
have and omitted the `value_bool` it does — exactly backwards.
`list_property_defs` returned `label`/`icon`, which do not exist, and omitted
`options`/`created_at`. `AttachmentRow.created_at` was an ISO string; it has
been epoch-ms since migration 0081. `filtered_blocks_query` omitted the
non-optional `total_count`.

Missing `op_refs` envelopes on five mutating commands: `set_property`,
`create_block` (two files), `delete_property`, `set_due_date` /
`set_scheduled_date`.

Two more path bugs: `useQueryExecution`'s "loading during initial fetch" gave
its single catch-all promise to the FIRST command issued —
`list_tags_by_prefix`, not `run_advanced_query` — so `loading` reached `false`
down the error path; and `useJournalBlockCreation`'s existing-page test was
resolving `create_block` off the previous test's leaked catch-all.

No `as any`, `as never`, or `@ts-` was added.

## Falsification

Before: 129 files / 1804 tests. After: identical. Four break-the-production-code
checks against copies, each restored and `cmp`-verified: the reschedule
due/scheduled preference (2 red), the direct-wins tag dedupe (1 red), the
attachment cache filter (3 red), and `useQueryExecution`'s `hasMore` (2 red).

## Method note

A `console.log` in the hook printed nothing under this repo's vitest setup, and
a `globalThis` counter read from a second test file printed 0 — vitest isolates
per file, so neither channel crosses. `process.stderr.write` does. A probe that
reports zero is worth doubting before the claim it was testing.
