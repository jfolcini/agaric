# Session 3194 — Link targets resolve in chunks the backend accepts

Found while reviewing #6214's page-mode probes. `fetchAndCacheLinks` sent every uncached link target of a page to `batch_resolve` in one call, and the backend refuses more than `MAX_BATCH_BLOCK_IDS` (1000) ids (`ensure_batch_within_cap`). A page linking more than 1000 distinct targets, in page mode (`resolveLinks`) or block mode (`useBlockLinkResolve`), got a `Validation` refusal, logged a warning and resolved none of its chips.

**What changed**
- `fetchAndCacheLinks` sends the ids in chunks of at most 1000, one after another, each with its own `try`/`catch`, and writes each chunk's answers back as it lands. A refused chunk no longer drops the others' answers. One chunk behaves as before. Sequential, so a large page does not take every reader connection at once.
- `MAX_TRASH_BATCH_IDS` in `src/lib/ipc-helpers.ts` is renamed `MAX_BATCH_BLOCK_IDS`, the Rust constant it mirrors, and its doc points at `ensure_batch_within_cap`.
- `docs/architecture/queries.md` notes the per-call cap.

**Left alone, checked**
- **`resolveTitles`** (`UnfinishedTasks`, `DonePanel`, `AgendaView` and others) sends its misses in one call too, and `UnfinishedTasks` can load up to 5000 tasks. But its ids are parent pages, and the resolve store preloads every page title in the space (`listAllPagesInSpace`), so they are cache hits; more than 1000 misses would need more than 1000 non-page parents. Not reachable in normal use.
- **The mock** enforces the cap on no batch handler, the trash ones included, so no mock-lane spec can show the refusal; the vitest stand-in refuses past 1000 the way the backend does.

**Red first:** with the chunk size set to every id, "resolves every target into the cache" (1001 targets) and "keeps the other chunk's answers when one chunk is refused" both fail; with the `catch` returning early, the second fails on the last id; without the `logger.warn`, it fails on the warn count.

**Suites:** vitest over `src/components/block-tree`, `src/editor/page-mode`, `src/stores`, `src/lib`, `src/hooks`, `src/components/pages`, `src/components/properties` and `TrashView`; typecheck; lint; the manual-stage hooks; Playwright `page-mode`, `link-chip-lifecycle`, `link-labels`, `inner-links`, `trash-bulk`, `trash-load-more` and `block-linked-references` (86 passed).
