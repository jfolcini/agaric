# Session 1848 — Logseq page properties and bookkeeping on import (#5160 phase 4c)

Decisions D14 and the P3 and P8 findings, with note 102 folded in: a Logseq page now imports as Logseq shows it.

**What changed.**
- **Page properties (P3).** The `key:: value` lines before a page's first block are front matter, where they used to be dropped with a warning.
  - `alias::` becomes the page's aliases and `tags::` its tags (created when missing). Each is a comma-separated list whose items may be `[[Page]]` or `#tag`.
  - Any other key is a page property, `title::` included; the page keeps its file-name title.
  - The pinned test `parse_orphan_property_before_any_block_warns_682` is flipped. A property line after a block with no owner is still dropped with the warning.
- **`id::` and `((uuid))` (D14, P8).** A block's `id:: <uuid>` line is its anchor, and a `((uuid))` naming it anywhere in the same file becomes a `((ULID))` ref.
  - The resolution reuses the deferred-anchor pass that already resolves `[[#^id]]` after the blocks exist.
  - The parser reads a file with both an `id::` and a ref to it twice, because the `id::` line may come after the ref.
  - A ref to no block of the file is still stripped and counted.
- **`collapsed:: true`** folds the block. Collapse is a per-device layout in localStorage, not a property, so `ImportResult` gains `page_id` and `collapsed`. The import runner writes them into that page's collapse layout.
- **`heading:: true`** makes the block a heading one level below its Logseq outline level, as Logseq renders it; `heading:: N` gives level N.
- **`:LOGBOOK:` drawers** are dropped through `:END:`, counted in one warning.
- **None of these lines stays a property.** A value Logseq does not write (`heading:: big`, a non-uuid `id::`) is kept as a property.
- **Note 102.** A `[[Page#Heading]]` into another page whose page repeats the heading refs the first one in document order, where it used to need exactly one. The same lookup serves paste and Edit as Markdown. The query now reads every live block of the anchored pages with its parent and position, and the heading text only for headings. `docs/features/import-export.md` now says "the first heading".

**Worth knowing:**
- A `((uuid))` resolves only within its own file. A ref into another file of a Logseq graph is still stripped: keeping it would need the uuid stored on the block, which is the same open question as an Obsidian `^name` across files (session 1833).
- A `((uuid))` in a code block stays text, as its links and tags do.
- A block with both a trailing `^id` and an `id::` keeps the `^id` as its anchor and the `id::` as a property.
- The mock's import reads none of this; it returns an empty `collapsed`.

**Verified.**
- `cargo nextest run --workspace`, targeted: the whole `agaric-engine` package plus the page, property-line, `commands::pages` and specta tests, 1506 passed. `just gen-sqlx` replaced one root query; the three crate caches are unchanged. Bindings are regenerated.
- Falsified on copies, 17 mutations, each red on the test that claims it: 12 in the parser (page properties, list splitting, reserved keys, collapsed, heading level, an existing heading, `id::` against an `^id`, the second read, kept refs, refs in code, the drawer, a drawer left open) and 5 in the command (first by id instead of document order, ancestors not first, refs unresolved, refs in code resolved, no collapsed ids). The ancestor-order mutation survived the first fixture; the nested heading now sits third under its block, and it goes red.
- vitest: 420 passed across the five touched files. `npm run typecheck` is clean. Playwright: `e2e/import-export.spec.ts`, 16 passed.
