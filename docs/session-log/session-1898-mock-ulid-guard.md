# Session 1898 — review note from #5319

The reviewer approved #5319 (#5286) with one non-blocking note. It is carried
here, per the sweep's follow-up rule.

## The note

- The mock's `blockLastEditedAt` took a creation time from any id of 10 or
  more characters, in either case, through `ulidToDate`. The backend's
  `ulid_created_ms_sql` decodes only a 26-character id whose first 10
  characters are an uppercase ULID time. A 25-character fixture id with no op
  therefore got a timestamp in the mock and the sentinel on the backend.
- `blockLastEditedAt` now applies the same guard: the length, and the
  backend's GLOB class as a regex.

## Verified

- Two new mock tests: a 25-character id and a lowercase id, each with no op,
  report a NULL last-modified time.
  - Dropping the length check turns the first red.
  - Dropping the regex turns the second red.
- `npx vitest run src/lib/tauri-mock`: 53 files, 1107 tests pass.
  `npm run typecheck` passes.
