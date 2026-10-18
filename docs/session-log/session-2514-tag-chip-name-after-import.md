# Session 2514 — a tag chip names a tag the preload missed (#5740)

**Found:** on the real backend, `e2e-tauri/import-obsidian-vault.e2e.ts`
sometimes saw an imported page's tag chip render `#01ABCDE...` instead of the
tag's name.

**Cause:**
- A `#[ULID]` chip reads its name only from the resolve store.
- The store's tag half is preloaded from `tags_cache`. The materializer fills
  that cache in the background, so a tag that an import just created can be
  missing when the import runner's post-import preload reads it.
- `useBlockLinkResolve` fetched missing `[[ULID]]` and `((ULID))` targets
  through `batch_resolve`, but never `#[ULID]`.

**Fix:**
- `ULID_LINK_RE` in `use-block-link-resolve.ts` gains a `#[ULID]` arm, so an
  uncached tag id goes to `batch_resolve` with the page and block ids.
- `batch_resolve` reads `blocks` directly, so it never waits on the cache.
- Page mode shares the scan and gets the fix too.
- A tag in another space, or a trashed tag, now renders the way page-link
  chips already do.

**Kept:** the import runner's preload. Search rows, the agenda, History and
the other plain store readers still depend on it.

**Specs:**
- `use-block-link-resolve.test.ts`: the scan collects a `#[ULID]`, and the
  hook fetches and caches its name.
- `e2e/tags-and-links-happy-paths.spec.ts` › Tag chip name: a tag created
  after boot, so the preload never listed it, shows its name in the chip.

**Shown red:** with the `#[…]` arm reverted, both vitest tests failed at their
own assertions, and the e2e chip read `#00000000...` instead of `fresh-tag`.

**Review:** two comments corrected: one credited the scan to the fetcher, and
the hook's doc listed only two token shapes.

**Ran:**
- vitest over `src/components`, `src/stores`, `src/hooks` and `src/editor`;
- `npm run typecheck` and `npm run lint`;
- every Playwright spec that asserts a `tag-ref-chip`;
- the new test three times with no retries.
