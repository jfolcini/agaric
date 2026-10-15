# Session 2130 — Four real-backend journeys, and a stale Search cache

#5366's remaining scenarios run against the real backend in `e2e-tauri/`.
Each one reads state that only the backend derives:

- **Agenda.** A weekly TODO due today projects into the Due panel of the
  day a week out. The mock has no projection.
- **Pages.** A page linked from two others tops "Most linked", which reads
  `pages_cache.inbound_link_count`. The older rival page would win the id
  tie-break if the count were ignored.
- **Tags.** Tagging a block raises the tag's count in the Tags view, and a
  rename relabels both the list and the block's chips (`tags_cache`). The
  mock never counts inline `#tag` references.
- **Search.** After a word in a block is edited, the new word finds the
  block and the old word does not. The real FTS index is updated by the
  background queue.

Building the Search journey found a product bug. The client's default
`staleTime` is `Infinity`, and a content edit fires no event that the
search key folds in. So retyping a query already answered in the session
served the cached rows, listing a block for a word it no longer held. The
search query now sets `staleTime: 0`. The vitest
`useSearchResults.staleness.test.ts` drives the in-memory backend: it
searches, edits the block, searches another word, then the first word
again. It failed without the fix on the final assertion. The real-lane
journey repeats the same query text, so it pins the bug too.

`search-bm25-order`'s re-submit poll presses Enter on unchanged text, so
it never asks the backend again. It has passed because its first search
already finds both rows, and it was not working around this cache, so it
is left alone.

Ran: `npm run typecheck`, `npm run typecheck:e2e-tauri`, the SearchPanel
vitest suites (193 tests), oxlint, oxfmt, typos. The Pages, Agenda, Search
and Tags flows were walked on the mock lane with Playwright up to the step
only the real backend can answer.

The real lane runs only in CI. Each journey is to be shown red there once
from a throwaway branch carrying one product mutation per journey: the
weekly step, the Most linked key, the tag count, the FTS old-row delete,
and the Search `staleTime`.
