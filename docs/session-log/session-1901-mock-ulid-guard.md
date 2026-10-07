# Session 1901 — review notes from #5319 and #5321

The reviewer approved #5319 (#5286) and #5321 (#5294) with one non-blocking
note each. Both are carried here, per the sweep's follow-up rule.

## The note

- The mock's `blockLastEditedAt` took a creation time from any id of 10 or
  more characters, in either case, through `ulidToDate`. The backend's
  `ulid_created_ms_sql` decodes only a 26-character id whose first 10
  characters are an uppercase ULID time. A 25-character fixture id with no op
  therefore got a timestamp in the mock and the sentinel on the backend.
- `blockLastEditedAt` now applies the same guard: the length, and the
  backend's GLOB class as a regex.

## The #5321 note

- The note: graph filters saved under the bare `agaric:graph-filters` key are
  no longer read once a space is active, so the old key stays in storage.
- No change. The bare key is still the list used while no space is active,
  so it is not dead data. A list saved there before #5321 was the cross-space
  state that caused #5294, so not carrying it into a space is the intent.

## Verified

- Two new mock tests: a 25-character id and a lowercase id, each with no op,
  report a NULL last-modified time.
  - Dropping the length check turns the first red.
  - Dropping the regex turns the second red.
- `npx vitest run src/lib/tauri-mock`: 53 files, 1107 tests pass.
  `npm run typecheck` passes.
