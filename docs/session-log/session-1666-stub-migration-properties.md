# Session 1666 — the typed seam found three stubs the backend cannot produce

#4668 step 2: migrate a directory of vitest suites off hand-written `invoke`
stubs onto `mockInvokeCommands`, the seam typed against the generated command
return types.

`src/components/properties/__tests__` was chosen because all four of its
backlog entries live there and nowhere else, so the directory goes to zero
rather than leaving a partial slice. 80 hand-stub sites across four files;
`MIGRATION_BACKLOG` 55 → 51.

`src/stores/__tests__/page-blocks.*` was considered and passed over: nine files
of positional `…Once` QUEUES, where successive calls to one command return
different values. Command-keying those is a per-test semantic rewrite, not a
migration.

## What the seam caught

This is the point of the issue, and it paid immediately. Three stub shapes the
backend cannot send:

- **`list_property_defs`** — `pageOf()` returned
  `{ items, next_cursor, has_more }`. `PageResponse<T>` carries a required
  `total_count`, which is *always* serialised — the binding comment says so, so
  consumers read it without an existence check. All 35 load stubs in that file
  were short one key.
- **`list_all_pages_in_space`** — twelve stubs returned bare `{ id, content }`
  where `PageHeading` also carries `todo_state`, `priority`, `due_date` and
  `scheduled_date`.
- **`set_property`** — resolved `undefined` where the command returns
  `WithOps<BlockRow>`. This one sits inside the seam's documented hole (a
  `()`-returning command legitimately resolves nothing), so it would not have
  redded — but it is still a shape the backend cannot produce.

A component tested against a response the backend never sends is green for the
wrong reason. That was true of 47 stubs in one directory.

## No assertion was weakened

All 106 tests kept their original assertions and pass. Every rejection-path
test migrated too — `mockInvokeCommands` takes a handler that rejects — including
the #4399 case that rejects with a bare `AppError` OBJECT rather than an
`Error`. That value is now annotated, which is stronger than before: the object
was previously unchecked.

## Falsification

Dropping `total_count` from `pageOf` — the exact key the migration added —
fails the build, re-run independently after the agent's own pass:

    error TS2741: Property 'total_count' is missing in type
    '{ items: PropertyDefinition[]; next_cursor: null; has_more: false; }'
    but required in type 'PageResponse<PropertyDefinition>'

Reverting the `PageHeading` shape fails the same way. Both against `cp` copies,
restored and `cmp`-verified, with `typecheck` back to exit 0 afterwards.

## One local helper

`PropertyDefinitionsList.test.tsx` keeps a small `stubInvoke` that MERGES into
the installed handler map: those tests stub the load, render, then stub the
mutation, and a flat re-install would drop the load handler so a re-fetch hits
`strictInvokeFallback`. The other three files install flat.
