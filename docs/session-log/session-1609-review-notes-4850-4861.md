# Session 1609 — review notes from five merged PRs, and the deadlock they hid

The non-blocking notes from #4850, #4855, #4856, #4859 and #4861 in one push,
per `AGENTS.md` § How we work: on an approved, green PR a non-blocking note
never earns a push of its own, because every push is another review round.

## What the notes were

- **`check-migration-mock-contract.py` claimed a completeness it did not have.**
  The scratch filter dropped every table whose name starts with `_`. That is
  three real prefixes (`_new_`, `_keep_`, `_preserve_`) and one table that is
  not scratch at all: `_op_log_mutation_allowed`, the op-log immutability
  triggers' bypass sentinel from migration 0036, which `op_log/bypass.rs` and
  `db/pool.rs` read at runtime. A table the filter drops appears in neither
  CONTRACT nor UNMODELED — precisely the hole the completeness assertion below
  it exists to close. Keying on the three prefixes surfaced a second
  unclassified name, `_spaces_backfill`, which migration 0089 creates and drops
  in the same transaction; it is now a by-name exception with the `db/tests.rs`
  assertion that says so cited beside it.
- **`handlers/history.ts` documented parity the mock does not have.** The
  `opBlockId` docblock said a `null` block id "mirrors the backend's NULL
  `block_id` closely enough". It does not: the backend's undo appends a real
  reverse op, which carries a `block_id` like any other, so the two branches
  that require one — per-page scope and `get_block_history` — drop rows the
  backend lists. The comment now says that, and names the mock's undo WRITE
  path as where the fix belongs.
- **Three comment blocks in `materializer/handlers/attachments.rs` restated the
  code beside them**, and `DELETED_ATTACHMENT_RETENTION_MS` was re-exported
  unconditionally although only tests read it; it is now gated the way its
  test-only siblings already were.
- **`conformance-snapshot.ts`** rebuilt a `Set` of `state.blocks`' keys to ask a
  question `state.blocks.has` answers, and its comment implied the existence
  test models tombstone ORDER. It does not — a fixture that deletes X and then
  writes `[[X]]` gets a mock edge the backend would not — so the comment now
  says what is not modelled and why tracking it would buy nothing.
- **Four PageBrowser suites carried identical private copies** of `pageList`
  and `stubInvoke`. They now share one pair in `src/__tests__/helpers/invoke.ts`,
  and the two suites that stubbed an empty page list in `beforeEach` stop doing
  so: a test that forgets its own stub must fail by name through
  `strictInvokeFallback`, not read an empty vault.
- **`useTrashDescendantCounts`** guarded `next ?? {}` against a value the
  command's return type cannot produce, with the same four-line comment copied
  into 48 call sites of `TrashView.test.tsx`. Both are gone.
- **From #4859's review**: the toggle's `contentEditable={false}` is inherited
  from `ImageNodeView`'s `NodeViewWrapper` (`:31`) and absent-by-default on the
  static surface, so it was a no-op; the `collapsible-image` class is selected
  by no rule or spec; and `collapsedLabel`'s docblock had the `data:` case
  backwards — `'data:image/png;base64,…'.split('/').pop()` is
  `'png;base64,…'`, so a `data:` src reaches the chip through the FILENAME
  branch, which is why the cap sits outside the branches. `docs/FEATURE-MAP.md`
  gains the collapsible-image row #4859 owed it.

## The deadlock

Sharing `stubPageRowInvoke` out of the four suites is what surfaced this. The
first draft imported `invoke` from `@tauri-apps/api/core` at module scope in
`src/__tests__/helpers/invoke.ts`. That helper is imported by
`src/test-setup.ts:8`, and `test-setup.ts:381` mocks `@tauri-apps/api/core`
with an **async factory that awaits importing the helper back** — so a static
import of the mocked module closes a cycle neither side can settle.

The symptom is not a failure. `vitest run` on ANY test file — including files
the change never touches — printed its banner and hung forever. Two runs sat at
0% CPU for 30 and 150 minutes before this was traced, and both times the first
guess was the worktree, not the diff: a fresh worktree at the same path passed
at `origin/main` and hung at the branch commit, which is the measurement that
settled it.

The helper now takes the caller's own `vi.mocked(invoke)` as its first
argument, and both imports it needs to name the type are `import type`, which
the transform erases. The reason is written above the function, because the
next person to reach for `vi.mocked(invoke)` in that file will hit the same
wall with no error message to read.

## Not fixed here — #4864

`image_collapsed` stores each folded `src` verbatim, and `isValidImageSrc`
accepts `data:`. Folding one pasted screenshot writes a multi-megabyte payload
into a ~5 MB localStorage origin; `writePreference` swallows the resulting
`QuotaExceededError`, after which **every** preference write in the app stops
persisting silently — theme, density, starred pages, saved views. The fix is to
stop keying on the raw `src`, which changes the stored key format of a
preference already shipped in 0.10.0 and so needs a `version` bump and a test.
That is a PR, not a line folded under a `chore:` commit, so it is #4864.

## Verified

- `npx vitest run` over the seven touched suites plus `src/lib/tauri-mock/__tests__`:
  **48 files, 1010 tests, all passing** (60.6 s).
- `npm run typecheck` clean.
- `cargo check --workspace` (no `test-util`) clean — the point of running it is
  the newly `#[cfg]`-gated re-exports, which a test-profile build would not
  have exercised.
- `cargo nextest run --workspace -E 'test(attachment)'` green.
