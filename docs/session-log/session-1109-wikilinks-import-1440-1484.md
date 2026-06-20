# Session 1109 — /batch-issues loop: human-readable wiki-link import (#1484, completing #1440)

#1440 (export: clipboard/export emits `[[Page Name]]`/`#tag`/`((Name))` via the resolve
cache; internal paths stay ULID-canonical) was already shipped. This adds the symmetric
IMPORT half (#1484):

- `internalizeRefTokens(content, resolvers)` (`src/lib/block-clipboard.ts`) — async mirror
  of `humanizeRefTokens`: `[[Page Name]]`→`[[ULID]]`, `#tag`/`#a/b`→`#[ULID]`. Skips
  bare-ULID bodies (canonical tokens survive a round-trip) and `#[` canonical tags; dedupes
  names; leaves a token plain when the resolver returns null. `((Block Name))` left plain.
- `buildImportRefInternalizers()` (`src/stores/page-blocks.ts`) — fetches page/tag lists
  once, creates missing pages/tags via the existing `createPageInSpace`/`createBlock({
  blockType:'tag'})` IPC, seeds new ULIDs into the resolve store; returns null (skip) when
  no active space. Wired into `pasteBlocks` after `parseIndentedMarkdown`.

Verification: canonical round-trip safe (ULID tokens never re-resolved/created); no
accidental creation (no active space → skip, ambiguous duplicate → left plain, names
deduped so a repeat creates once); resolution correct (existing → link, new → create,
nested tags); the export half is untouched (zero removed lines). A `#tag` substring inside
an unresolved `[[Page Name]]` is left intact (guarded). 3397 vitest pass; tsc + oxlint clean.
