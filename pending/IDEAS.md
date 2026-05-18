# Ideas

Forward-looking speculative ideas that aren't (yet) plans. **Distinct from `REVIEW-LATER.md`**: that file tracks deferred-but-scoped maintenance tombstones with concrete cost / blocker / revisit-trigger. This file tracks ideas that are *not yet committed to becoming plans* — they're notes about directions worth thinking about later, not work waiting to be scheduled.

> **Convention.** Each entry is short (one paragraph, ≤ 200 words). When an idea matures into a real plan, it moves to `pending/PEND-NN-*.md` and gets deleted here. When an idea is rejected for cause, delete it without ceremony — `git log` is the audit trail.

---

## Search-adjacent

### Saved searches

A saved search is a stored query string from the find-in-files view (PEND-50 foundation + PEND-54 filter framework). Because PEND-54 makes the query string the canonical source of truth for filters and free text (`TODO state:DOING priority:1 path:Journal/*` is the whole filter portion), a saved search needs:

- The query string (filters + free text).
- The toggle state (`{ caseSensitive, wholeWord, isRegex }`) — **PEND-55 deliberately keeps toggles non-writable as inline syntax** so toggle state lives separately from the query string. A saved search is therefore `(name, queryString, toggles)`, not just `(name, queryString)`.

UX shape (sketched, not committed):

- A `+ Save search` button next to the toggle row.
- A "Saved" section in a sidebar tab listing all saved searches; clicking one populates the input.
- Saved searches optionally surface as block-renderer "smart list" embeds (the Org-mode / Obsidian Dataview pattern) — a block with `{{search:my-saved-search-name}}` renders the live results inline.

Cost (if pursued): M (~1-1.5 days) for the basic save/load/list; another M for the inline-embed renderer.

Why this isn't a plan yet: the inline-embed sub-feature opens a much bigger design space (live-updating embedded queries, recursive embed protection, layout). The save/load alone is too small to commit to without a clearer use case from real workflow friction. Revisit after PEND-50 has shipped and the maintainer's own usage shows whether saved queries actually solve a recurring problem or just sit unused.

### Search-and-replace

Find-and-replace across all matching blocks. Conceptually appealing; in Agaric specifically, **likely low value at high cost**.

Why low value: page renames go through the existing centralised page-rename path (via `set_page_aliases` at `src-tauri/src/commands/pages.rs:1090`, which is alias-aware). **Tags are not centrally renamed today**: there is no `rename_tag` IPC; tags are blocks with `block_type='tag'` whose label is the block's content, so renaming happens through normal block-content editing — but because tag references resolve by ULID, edits propagate to every reference automatically. The remaining use cases for search-and-replace — bulk text corrections, terminology updates, link reformatting outside of tag/page identifiers — are real but infrequent for a personal note-taking app.

Why high cost: blocks store content as ProseMirror-serialised HTML/JSON inside TipTap. A naive string-replace on stored content would corrupt marks, inline-query embeds, internal `[[page]]` links, and tag pills that straddle the match boundary. The safe path is to re-hydrate each block's content into a ProseMirror doc, run a transaction-based replace via TipTap's command API, and re-serialise — which is expensive per block (parser overhead × number of matching blocks) and risky on edge cases (mark boundary splits, embedded queries with text that happens to match).

If pursued, scope it to **plain-text replace only**, with a strict "skip and warn if the match crosses a mark / span / embed boundary" rule. Preview-and-confirm UX (show all proposed edits, let the user un-check rows) is mandatory — silent bulk edits in a notes app are unacceptable. Cost would be L (multi-day) for the safe-scope version, with the preview UX being the bulk of it.

Revisit if the maintainer actually wants to do a bulk rename and finds the tag/page channels insufficient.

### `[[page]]` autocomplete inside the page editor (not just the palette)

PEND-51 adds `[[` autocomplete in the **palette** for inserting a page link into the previously-focused block. But the more natural place to autocomplete `[[` is *inside the editor itself*, when the user types `[[` mid-paragraph. This already exists in Obsidian and Logseq; Agaric's TipTap stack could add it as a Suggestion extension. Probably worth its own small plan once the palette version (PEND-51 Phase 3) lands and the autocomplete-popover infrastructure is proven.

### Semantic / AI-augmented search

Outside-scope for the current direction (local-first, no cloud), but worth a note: if a future direction adds local embedding models, semantic search ranks results by meaning rather than substring match. Would compose cleanly with the existing FTS5 pipeline as a re-rank step on the top-N candidates. Cost: large (model packaging, on-device inference, embedding storage). Not now.

---

## Editing surface

### Emoji picker + emoji support

A `:` trigger inside the editor opens an emoji picker that filters by shortcode prefix (`:smi` → 😀 😁 😃 …); Enter inserts the picked emoji at the caret. Plus a small palette-style overflow button for browsing/searching by category. Matches the universal pattern from Slack / Discord / GitHub / Notion. Likely fits as a TipTap Suggestion extension alongside the existing `[[` page-link suggestion path.

Sub-scope to think about before committing to a plan:

- **Picker UI shape.** Inline popover anchored at the caret (matches `[[`); separate Cmd-shortcut palette (matches `Cmd+E` in some apps); both. The inline one is the load-bearing surface; the palette is nice-to-have.
- **Emoji set + storage.** Use the Unicode emoji set as-is (no custom emoji in v1). Skin-tone modifier handling (`:thumbsup::skin-tone-3:` style) is its own design question — defer.
- **Search index.** Either bundle a static `shortcode → codepoint` map (a few hundred KB JSON) or pull a small dep (`emoji-mart-data` is the canonical one; ~150 KB gzipped). Bundle size is the trade-off.
- **Storage.** Emojis are just Unicode codepoints; no schema change. They round-trip through TipTap as text nodes the same as any other char.
- **Mobile.** OS native emoji keyboards work today (no Agaric work). The picker is a desktop affordance; on mobile the Cmd+E palette can still surface the search-by-name UX for users who don't remember an emoji's shape.
- **Tag interaction.** Tag pills use emoji freely today (a tag named `🔥 hot` already works). The picker should NOT interfere with the tag-input path — `:` mid-tag-typing is ambiguous and the tag input has its own suggestion machinery.
- **Activity-feed / search.** Indexed naturally as Unicode text; FTS5 trigram tokenizer handles emoji as multi-byte glyphs without special handling. No backend work.

Cost (if pursued): S-M (~6-10 h frontend) for the inline-picker Suggestion extension with a bundled shortcode map. M (~3 h on top) if the Cmd+E palette is added.

Revisit when typing emoji becomes a recurring friction point (mostly on desktop without OS-native shortcuts).
