# Session 4171 — the bridge vault holds the mock's seed, and a nightly Playwright project runs on it (#6529 stages 1b and 1c)

Finishes stage 1b of #6529 (session 4121 left its seed, `Channel` messages and `@mock-only` tags open) and builds stage 1c. One PR. The maintainer decided the three open items as the issue comment recommended: seed through the real commands, `Channel` progress stays on the mock, tags land with 1c.

## Shipped

- **A page takes a client id.** `create_page_in_space_inner_with_id` passes `create_block`'s `blockId` on to `create_block_in_tx`, as the tag path already did; `create_page_in_space_inner` keeps its signature and passes none. A held id is refused as `conflict`, and a title the space already holds still answers with that page. The mock's `create_block` does the same. No caller in `src/` sends a `blockId` for a page, so nothing in the app changes.
- **The `BLOCK…` seed ids are respelled `B10CK…`.** `L` and `O` are not Crockford base32, so the commands refused them. Every literal in `e2e/` moved with `seed.ts` by one `sed`; the `PAGE…` and `TAG…` ids were valid already.
- **`seedCommands`** (`src/lib/tauri-mock/seed-commands.ts`): the mock's seed as the commands that write it, read from `seedBlocks`' own stores, so there is one seed. `e2e/bridge.ts` sends them to its bridge once per worker and then sends `keep`.
- **`keep`**, a fifth bridge op: the open vault becomes the template every later `reset` copies.
- **The `real-backend` Playwright project.** With `AGARIC_E2E_BRIDGE` set, the run is that project: the specs `REAL_BACKEND_SPECS` lists in `playwright.config.ts`, minus tests tagged `@mock-only`. Thirteen spec files, 43 tests. Unset, the run is the mock's `chromium` project, unchanged.
- **The nightly run.** Shard 2 of `full-suite-nextest` in `scheduled-deep-checks.yml` builds the bridge after its tests and runs the project. `clippy-clean` lints the bin by name. No new job, no required check.

## Decisions

- **The seed is derived, not restated.** `seedCommands` walks the mock's maps after `seedBlocks()`. A second hand-written list of the seed would drift from the first.
- **The space is matched by name.** The mock's `SPACE_PERSONAL` is not a ULID; the backend's Personal is `00000000000000000AGAR1CPER`. The seeder asks `list_spaces` for the space named Personal. The mock's space ids were not respelled: see "Left".
- **`keep` does not settle the materializer.** A version that flushed the queues first passed the same test as one that did not, three runs each, including an assertion on a page link written by a background rebuild. A reopened vault has the view either way, so the flush was deleted.
- **An allowlist, not `grepInvert` alone.** Most specs fail on the bridge for reasons a `@mock-only` tag does not name, so the project runs the files that pass. A spec joins the list when it passes there.
- **Tags only inside listed files.** A tag on a file outside the list is read by nothing, and a wrong one would hide a passing test the day the file is listed. One test is tagged: the `__addMockAgendaItems` test in `search-results.spec.ts`. The tag is Playwright's `{ tag }` detail, not a title tag, so the area vocabulary `scripts/e2e-related.test.mjs` checks is unchanged.
- **The nightly run sits in the nextest job.** That job has compiled the workspace with `test-util` on, so the bin is a link. A job of its own would cost a cold build and a runner slot for a one-minute run. The steps use `!cancelled()` so a red nextest does not hide a red spec.
- **`tsconfig: './tsconfig.e2e.json'` in the Playwright config**, with the `@/` alias added there: `e2e/bridge.ts` imports from `src/`, and oxlint forbids a relative import inside `src/`.

## Traps

- **The bridge bin did not build on `main`.** #6767 made `commands::tests::common::settle` call `assert_saved_engines_match_live`, which `agaric-engine` compiles only under its own `test-util`. Every test build turns that on through a dev-dependency; the bin is the one build of the app's `test-util` outside a test profile, and nothing built it. The app's `test-util` now enables `agaric-engine/test-util`. The nightly build is what catches the next one.
- **`conformance-coverage.test.ts` refuses a fixture id that is neither seeded nor created.** A fresh client id for the page is therefore a seed block purged first (`S5`), as `S4` is for the content block.
- **`CONFORMANCE_UPDATE=1` rewrites every fixture's formatting.** `npx oxfmt --write conformance/fixtures/` puts it back (`just ipc-check` runs both).
- **oxfmt reflows a test whose signature grows past the column limit**, so the tagged test's body shows as changed.
- **`target/debug/incremental` reached 15 GB** in a cloud session with a dev build, a test build and clippy in one tree. Deleted, and `CARGO_INCREMENTAL=0` after that.

## What the bridge run found

133 tests in the 30 search, query and history spec files were run once on the seeded bridge: 76 passed, 51 failed, 6 were skipped or did not run. The 51, by what the failure printed:

- **40: a literal `SPACE_PERSONAL`**, mostly through `seedSearchBlocks` in `e2e/helpers.ts`. The backend refuses it as a malformed space id.
- **4: a spec's own `ipc()` call rejected** (`search-replace.spec.ts`, `tags-query-modes.spec.ts`). The rejection was not read further.
- **1: a mock hook**, the test now tagged.
- **6: an assertion**, one each in `advanced-query-group`, `block-history-sheet` (two history rows expected, three shown), `history-advanced` (one `<ins>` expected for an edit's diff, three shown), `history-page-scope` (three rows expected, eleven shown), `history-revert` and `search-toggles`. None was triaged: each is either the seed's missing backdated op-log rows or a place the mock and the backend differ, and stage 2 finds out which.

## Shown red

- `seed-commands.test.ts`: `due_date` left out of the walk; the rebuilt vault differs on the dated tasks.
- `a_kept_vault_is_what_every_later_reset_opens`: a `keep` that leaves the old template; the page seeded before the keep is `not_found`. A first mutation that copied the vault over the template stayed green because it still replaced it.
- The fixture, on the backend: the page path given no client id; `a_page_refuses_a_held_id` succeeds. On the mock: the handler ignoring a page's id; the same op succeeds.
- The project: `search_blocks` given a fixed nonsense query in its wrapper, the bin rebuilt; 9 of 43 tests fail, in three spec files.

## Left

- **The mock's space ids.** Respelling `SPACE_PERSONAL` and `SPACE_WORK` to the backend's two ids would let every spec that creates its own blocks run on the bridge. It is 132 literals in 96 `e2e/` files plus the mock and its tests, and it was not in what the maintainer decided.
- **`e2e/AGENTS.md` § "The real backend, through the bridge"** still says the vault is a first boot's, that `SEED_IDS` name nothing and that no CI lane runs specs this way. This session was told not to edit any `AGENTS.md`.
- **The auto-filed issue names the lane, not the spec.** `file-scheduled-failures.mjs` reads job results only; the spec's name is in the run's annotations. Stage 1c's "done when" asks for the spec in the issue.
- **A green scheduled run** exists only after the first night on `main`.

## What ran

Before `main` moved: `cargo nextest run --workspace` (8174 passed), the full vitest suite, `npm run typecheck`, `npm run lint`, clippy on the workspace and on the bin, `just gen-bindings` with no diff, `prek run --all-files` and the manual stage. The `real-backend` project twice on a bridge built from the final code, 43 passed each time. On the mock: four spec files, two of which name seed ids, and `--list` showing the same 2054 tests as before the change.

After merging `main` (one commit, which removed a Tauri plugin): both clippy runs, `just gen-bindings` with no diff, the `command_integration` binary (358 passed), `npm run typecheck`, vitest over `src/lib` and `src/components/properties`, the `real-backend` project on a rebuilt bridge and bundle (43 passed), and six mock spec files that name seed ids (79 passed). The whole Playwright lane did not run locally; 80 spec files changed, so CI runs it.

The scheduled workflow's new steps have not run: they are reachable only from `main`'s cron or a dispatch.
