<!-- markdownlint-disable MD060 -->
# List Ergonomics — Block-level vs Per-line Formatting

Analysis and design proposal for issue #3000. Companion to
`docs/architecture/editor-and-content.md` (content format + serializer contract)
and `docs/features/editor.md` (user-facing editor behaviour). Records the
decision made on #3000, benchmarks it against comparable tools, and specifies
the model precisely enough to drive the follow-up implementation work.

## Context

Agaric is a block outliner: every block is a row in the `blocks` table
(`src-tauri/migrations/0001_initial.sql:5`), nesting is `parent_id` + `position`
(same file, lines 9–10), and structure is edited with indent / dedent
(`src/stores/page-blocks-types.ts:99`). A single **roving** ProseMirror editor
mounts on the focused block and unmounts on blur; every other block renders as
static HTML (`src/editor/use-roving-editor.ts:1`, `docs/architecture/editor-and-content.md`
§ Roving-editor invariant).

Against that grain, ordered/unordered lists are currently modelled **inside** a
block as real ProseMirror `bulletList` / `orderedList` / `listItem` nodes
(stock `@tiptap/extension-list`, `use-roving-editor.ts:24`). List-ness is also
baked into the block's markdown `content` string as a `-` / `1.` prefix, and
created by prepending that prefix to the text (`use-block-tree-event-listeners.ts:195`,
`block-type-convert.ts:105`). The visible marker comes from the browser's native
CSS list-marker on `<ul>`/`<ol>` (`src/index.css:1176`), not from anything
agaric draws.

This is the "odd fit" the issue names: lists neither apply to the whole block
nor are they cleanly fenced. They live as a *second, in-block* tree that
competes with the outliner's *own* tree — two indentation mechanisms, two
notions of "an item", and a marker whose lifecycle (`splitListItem` on Enter,
native disc on a `<ul>`) is disconnected from how every other block behaves. It
produced the concrete bug in #2999 (marker and content split onto separate
lines) and a latent markdown round-trip bug (see § Round-trip).

**Goal (from the issue):** a block should carry as much or as little formatting
as the writer wants, *without forcing one-block-per-line* — one item per block
allowed as an option, not a requirement. Deliverable: an analysis of writing
ergonomics benchmarked against org-mode, Obsidian, Logseq, and Notion, plus a
design proposal for how lists/blocks should compose.

## How the four reference tools handle list/outline writing

| Tool | Unit of structure | List-ness lives as | Marker | Indent mechanism | Grain (item ↔ line) |
| --- | --- | --- | --- | --- | --- |
| **org-mode** | Plain-text lines in one buffer | Line prefix (`-`, `1.`, `+`) in the text itself | The literal character you typed | Leading whitespace on the line | Fully free — a "block" is whatever text you group; soft-wrap and continuation lines are just text |
| **Obsidian** | Markdown file (CodeMirror) | Line prefix in the source text | Rendered from the source marker (live preview) | Leading whitespace | Free — same as any markdown; folding is derived from indentation |
| **Logseq** | Block (outliner, one block per bullet) | **Implicit** — every block *is* a bullet | Always-on bullet dot in the gutter | The block tree (Tab / Shift-Tab) | Rigid — one bullet per block is mandatory; multi-line is a soft break *inside* the block |
| **Notion** | Block | **Block type** attribute (`bulleted_list_item`, `numbered_list_item`) | Drawn by Notion in the content column, computed | The block tree (Tab / Shift-Tab); numbers auto-recompute | Free — `Enter` = new item block, `Shift+Enter` = soft line break inside the block |

The ergonomic lessons:

- **org-mode / Obsidian** feel fluid for *prose-with-lists* because list-ness is
  just text — nothing structural to fight. The cost is that "list" and "content"
  are entangled: every consumer must re-parse prefixes, and the same `-` means
  "bullet" or "literal hyphen" depending on context. Agaric's *current* model is
  effectively this (prefix-in-content) **plus** a redundant PM node tree — the
  worst of both: text entanglement *and* a competing structure.
- **Logseq** feels great for *pure outlining* (frictionless Tab/Enter, one
  thought per bullet) but is coercive: you cannot have a block that is *not* a
  bullet, and you cannot put two list items in one block. That violates #3000's
  "not forced one-block-per-line".
- **Notion** is the closest match to what #3000 asks for: list-ness is a **block
  attribute**, the marker is **computed and drawn in the content column**,
  nesting reuses the **one** block tree, and the **grain dial** (`Enter` vs
  `Shift+Enter`) lets a block hold one item or many lines at the writer's
  discretion. Numbers recompute on reorder because nothing numeric is stored.

**Conclusion:** adopt the Notion model — list-ness as a block-node attribute —
but keep agaric's markdown-text storage and lossless FE serializer, and keep
agaric's deliberate choice *not* to force a bullet on every block (unlike
Logseq). The marker is therefore information-bearing and must render as a
first-class inline decoration, not as native `<ul>` chrome.

## Decision (recorded on #3000, 2026-07-22)

1. **List-ness is a block-node attribute** `listStyle: none | bullet | ordered`
   (default `none`). It is **not** a markdown prefix baked into `content`, and
   **not** a ProseMirror `bulletList › listItem` node.
2. **Marker = leading inline decoration** at the start of the block's text line
   (a widget decoration / `::before` in the *content column*), never in the
   gutter. The gutter's hit-targets are already contested and historically
   fragile; a content-column decoration also matches how Notion draws markers.
3. **Ordered numbers are computed**, not stored: the number is the block's
   position among consecutive same-`listStyle`, same-depth siblings, recomputed
   on reorder/insert. This mirrors the serializer, which already emits positional
   `${idx + 1}.` and discards any parsed literal (`markdown-serialize.ts:922`,
   `markdown-parse/parser.ts:407` — the ordinal is regenerated, never preserved).
4. **Nesting stays the block tree** (Tab / Shift-Tab → indent/dedent). No second
   indent mechanism inside a block. This retires the in-block PM list node
   entirely.
5. **Grain dial:** `Enter` = new sibling block (fine-grained, one item per
   block); `Shift+Enter` = soft line break inside the block (coarse-grained,
   multi-line block). A block holds as much or as little as the writer wants —
   splitting is optional, satisfying the #3000 goal.
6. **Backspace at line start = strip style, then merge:** first press
   `bullet/ordered → none`; second press merges into the block above. Matches
   Notion and fixes the "merge into the wrong place" behaviour from #2999.

**Rationale:** at the outliner-block level agaric paints *no* default marker (a
plain paragraph block has no bullet — the native disc in `index.css:1176` only
appears for an explicitly-created *in-block* `<ul>`, which this model removes).
So a marker is information-bearing (keep both `bullet` and `ordered`), but the
gutter is off-limits — hence an inline content-column decoration rather than
gutter chrome or a schema-bending list node.

### Where the attribute is stored

Agaric already has a generic, migration-free home for block attributes: the
`block_properties` key/value table (`0001_initial.sql:25`, typed value columns;
schema registry in `property_definitions`, `0011_property_definitions.sql:2`).
Two options were considered:

- **`block_properties` row (recommended).** Store `listStyle` as a `value_text`
  property with a `select`-type `property_definitions` seed for its allowed
  values. **No `blocks` schema change**, no `BlockRow` change, no touching the
  ~20 `query_as!` sites. Reserved-key gate in `op.rs:483` is only for the five
  column-backed keys, so `listStyle` is unaffected. Reuses `set_property` /
  `get_property` (`src/lib/tauri/properties.ts`, `use-block-properties.ts:102`).
- **Column-backed on `blocks` (not recommended for v1).** Only justified if
  ordered-number recomputation needs an indexed SQL query over siblings, which
  it does not (the sibling set is already materialised in the per-page store,
  `page-blocks-types.ts:15`). Column-backing costs an `ALTER TABLE`, updates to
  all four column-list consts in `block_row_columns.rs:64`, every `query_as!`,
  the `BlockRow` / `ActiveBlockRow` structs, and the generated `bindings.ts`.

Recommendation: **`block_properties`**. Revisit column-backing only if a future
query needs to filter/sort blocks by list style at the database level.

## Markdown round-trip (export → import → export)

**Verdict: compatible.** `export ∘ import` is a stable fixpoint (`f(f(x)) = f(x)`)
because both sides share a canonical form. The serializer is already
property-tested for round-trip identity and idempotence
(`docs/architecture/editor-and-content.md` § Custom serializer;
`markdown-roundtrip.property.test.ts`), so the new model must preserve those
invariants.

- **Bullet:** `{bullet,"foo"} → "- foo" → {bullet,"foo"} → "- foo"`. Stable with
  a fixed canonical bullet char (`-`, matching `serializeBulletList`,
  `markdown-serialize.ts:930`).
- **Ordered:** the number is computed → import **discards** the literal and
  re-derives from position → export always emits positional numbers. `1./2./3.`
  is a fixpoint; non-canonical input (`1./1./1.`, `3./7.`) normalises on the
  first pass and is stable thereafter.

Two requirements to actually get idempotence:

1. **Canonical export** — fixed bullet char, fixed indent width
   (`LIST_NEST_INDENT = '  '`, `markdown-serialize.ts:873`), positional numbers.
   Otherwise the first pass converges but is not a no-op.
2. **Escape marker-like plain content** — a `listStyle: none` block whose text
   literally starts with `-` or `1.` must be escaped on export (`\- …`) and
   unescaped on import, or it round-trips *into* a list.

   **Latent bug to fix as part of this work:** `stripBlockMarker`
   (`src/lib/block-type-convert.ts:48`) strips `-` / `1.` **unconditionally**,
   so a plain block beginning with those characters loses them. The parser side
   already guards this correctly — `leading-block-markers.test.ts` asserts that
   `- bullet-ish`, `1. ordered-ish`, etc. round-trip back to a plain paragraph —
   so the fix is to bring `stripBlockMarker` (and the `convertBlockContent` path,
   same file) in line with that escaping contract.

**Caveat — the coarse (multi-line) block option.** Intra-block soft breaks
(`Shift+Enter`) and indentation-based child nesting both want indentation in
markdown. This is idempotent **only** if exporter and importer honour, byte for
byte, **CommonMark's list-item continuation rule**: a line indented to the
item's *content column* is a lazy continuation / soft break (same block); a line
that is itself a deeper marker is a child block. The parser's existing
`collectListItem` indent/dedent logic (`markdown-parse/parser.ts:473`) is the
starting point but must be reconciled with the new "content column = marker
width" convention. **Pin this rule down before building the coarse option**; the
single-line model needs no such rule and should ship first.

## Compatibility with existing content

Existing documents contain real `bulletList`/`orderedList` nodes and `-`/`1.`
prefixes in `blocks.content`. Migration is **lossless and lazy**, done entirely
in the FE serializer round-trip — no data migration:

- **Parse:** a block whose content is a single-item list marker becomes a block
  with `listStyle = bullet|ordered` and the marker stripped from `content`. A
  block whose content is a *multi-item* list (created today by the toolbar or a
  paste) is split into one block per item on blur, reusing the existing
  auto-split path (`shouldSplitOnBlur` / `splitBlock`,
  `docs/architecture/editor-and-content.md` § Auto-split on blur), each carrying
  the `listStyle` attribute.
- **Serialize:** emit the marker from `listStyle` instead of from an in-block
  list node. The `bulletList`/`orderedList` serializers
  (`markdown-serialize.ts:915`) and parsers stay only as long as needed to read
  legacy multi-item content, then can be retired once no content produces them.
- **Read-only renderer:** `RichContentRenderer/marks/orderedList.tsx` and
  `marks/block.tsx` gain a path that draws the computed marker for a
  `listStyle` block, mirroring the editor decoration.

## Proposed implementation roadmap (follow-up issues)

This document is the #3000 deliverable (analysis + design). The build is
sequenced as separate slices so each is independently shippable and testable:

1. **Round-trip bug fix (standalone, small).** Make `stripBlockMarker` /
   `convertBlockContent` escape marker-like plain content per the contract
   above; extend `leading-block-markers.test.ts`. Ships without any of the model
   work and removes a real latent bug.
2. **`listStyle` attribute + storage.** Add the `select` property definition
   (seed migration), thread `listStyle` through the block model on the FE, wire
   `set_property`/`get_property`. No `blocks` schema change.
3. **Marker decoration.** Render the leading inline decoration in the editor
   (widget decoration / `::before` in the content column) and the matching path
   in the read-only renderer; delete the native `<ul>/<ol>` CSS reliance
   (`index.css:1176`) for the outliner path. Guard with the #2999 marker test.
4. **Ordered-number computation.** Compute the ordinal from consecutive
   same-style, same-depth siblings in the per-page store; recompute on
   reorder/insert.
5. **Keyboard grain + backspace.** `Enter` = sibling block, `Shift+Enter` = soft
   break (largely already the outliner default — `use-block-keyboard.ts:365`),
   and Backspace-at-start strip-then-merge (`use-block-keyboard.ts:437`).
6. **Legacy list retirement.** Once content no longer produces in-block list
   nodes, remove the TipTap `BulletList`/`OrderedList`/`ListItem` extensions and
   collapse the serializer/parser to single-block markers.
7. **Coarse multi-line option.** Only after the CommonMark continuation rule is
   pinned down and mirrored in exporter + importer.
8. **Single-step list picker (shared with #3001).** The list-style toggle uses
   the same one-step inline-picker pattern as the callout/code selector; adopt
   whatever #3001 landed. Independent of the model work above.

## Verification

- **Serializer round-trip / idempotence:** extend and run
  `src/editor/__tests__/markdown-roundtrip.property.test.ts`,
  `markdown-roundtrip-fidelity.test.ts`, and `leading-block-markers.test.ts`
  (`npx vitest run src/editor/__tests__/markdown-roundtrip*`). The property
  tests must still assert `parse(serialize(parse(md))) == parse(md)` with
  `listStyle` blocks in the arbitrary.
- **Marker rendering:** `src/lib/__tests__/editor-list-marker-css.test.ts`
  (the #2999 guard) plus a new test that the decoration renders on the same line
  as the text and that a `none` block shows no marker.
- **End-to-end:** editor Playwright specs (`npx playwright test e2e/*.spec.ts
  --workers=1`, per `docs/architecture/editor-and-content.md`) covering: toolbar
  toggle → marker on same line; Enter → new item; Shift+Enter → soft break;
  Backspace-at-start → strip then merge; reorder → numbers recompute.
- **Data-model:** `set_property`/`get_property` round-trip for `listStyle` via
  the store, and confirm no `blocks` migration is required.

## Related issues

- **#2999** (closed) — the concrete bug (marker/content line-split + wrong-place
  merge) this model resolves; slice 1/3/5 above.
- **#3001** (closed) — shares the one-step inline-picker UI direction; the
  list-style toggle reuses that pattern but is otherwise independent.
