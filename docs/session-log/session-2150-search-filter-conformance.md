# Session 2150 — search_blocks structured filters pinned by conformance

#5366's last open item. No conformance step drove `search_blocks` with a structured filter: the existing steps covered `parentId` and the regex, case and whole-word toggles. So the mock's search filtering was checked against nothing.

`conformance/fixtures/query_search_blocks_filters.json` adds seven steps. Each is a blank-query search under one filter, so it takes the filter-only path, ordered by id. Its `expected` was authored by the backend (`CONFORMANCE_UPDATE=1`).
- The seed is two pages, "Alpha Project" and "Beta Archive". Their blocks are given states, priorities, due dates, an `effort` property and a tag through ops.
- Every step keeps some of the seeded blocks and drops others:

| Step | Keeps | Drops |
|---|---|---|
| `search_state_todo` | the three TODOs | the DONE and stateless blocks |
| `search_priority_2_or_3` | priorities 2 and 3 | priority 1 and blocks with no priority |
| `search_due_on_or_after` (`gte`) | three blocks, one exactly on the boundary | January and undated blocks |
| `search_property_effort_high` | `effort=high` | `effort=low` and blocks without the key |
| `search_tag_urgent` | the tagged blocks | the untagged ones |
| `search_include_page_glob` | Alpha's blocks | Beta's |
| `search_exclude_page_glob` | Beta's blocks | Alpha's |

The mock already agreed on every step, so no mock code changes.

Falsified on a copy of the mock's `handlers/search.ts`: each filter's handling was mutated in turn by ignoring it, mapping `gte` to `after`, or checking key presence only. Each mutation fails exactly its own step. The file was confirmed byte-identical after restore.

Found, not fixed: the TypeScript seed loader gives a top-level tag block a null `page_id` and no space, where the backend's runner gives it `page_id = self` in the test space. No fixture seeds one, and this one nests its tag block under a page as the others do.

Ran:
- `cargo nextest run --workspace -E 'test(conformance)'`: 107.
- `npx vitest run src/lib/tauri-mock`: 1135.
- `npm run typecheck`.
- `oxfmt --check` on the fixture.
