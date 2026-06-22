# Session 1121 — #1960 per-style round-trip tests + editor↔view parity

Follow-up to the merged "Turn into" menu (#1964, which landed the block-transform
half of the unified formatting surface and shipped 0.6.8). This session closes the
two remaining items called out on the #1960 umbrella issue:

1. **Per-style markdown round-trip tests** (`markdown-parse` ↔ `markdown-serialize`)
   **and HTML paste/export parity** for every style the "Turn into" menu surfaces.
2. **Editor↔view styling parity audit** across those surfaced block types.

## What shipped

### 1. Per-style round-trip coverage

- **`markdown-serializer.test.ts`** — a single auditable matrix,
  `"Turn into" menu — per-style markdown round-trip (#1960)`, proving
  `serialize(parse(md)) === md` for every menu style: Text, H1–H3, bullet list,
  ordered list, quote, code block (with/without language), callout, divider —
  plus a marks-carrying variant for each style that has a text body. This fills
  the one gap the audit found: standalone **H1–H3** had dedicated parse/serialize
  tests but no per-style *string* round-trip entry.
- **`html-to-blocks.test.ts`** — a `"Turn into" styles — HTML paste parity (#1960)`
  suite asserting each style with an HTML representation walks the clipboard path
  to a block that re-parses to the correct node (`paragraph`, `heading` + level,
  `bulletList`, `orderedList`, `blockquote`, `codeBlock`, `horizontalRule`).
  Callout is intentionally absent — it has no standard HTML element and is reached
  via markdown / slash / turn-into, all covered by the round-trip matrix.

### 2. Bug found and fixed by the parity work

`<hr>` was **silently dropped on HTML paste**: `<p>a</p><hr><p>b</p>` walked to
`"a\nb"`, merging the two paragraphs and losing the divider — a violation of the
#1960 lossless-HTML-paste constraint. `html-to-blocks.ts` now emits a `---`
divider block for `<hr>` (the parser's `parseHorizontalRule` rebuilds the
`horizontalRule` node), so the divider survives: `"a\n---\nb"`.

### 3. Editor↔view styling parity

The audit compared the editor's `.ProseMirror` CSS (`src/index.css`) against the
read-only view's renderer classes (`RichContentRenderer/marks/*` + `context.ts`).
Divergences found and fixed in `src/index.css`:

- **Bullet / ordered lists** had **no** `.ProseMirror ul/ol` rules at all — they
  fell back to raw browser defaults while the view uses `list-disc/list-decimal
  list-inside`. Added matching rules.
- **Divider** had no `.ProseMirror hr` rule (UA default) vs the view's
  `my-2 border-t border-border`. Added.
- **Headings h1–h4** were non-responsive in-editor (`text-2xl`…) while the view
  scales responsively (`text-xl sm:text-2xl`…). Editor headings now mirror the
  view's `HEADING_CLASSES` at every breakpoint. (h5/h6 already matched.)

In each case the editor now applies the **exact same Tailwind utilities** as the
view, so parity holds by construction — the same approach the table-style block
already documents.

### Documented, intentional divergence

**Callout icon.** The view renders a lucide icon in the callout header; the editor
uses a CSS-only `::before` showing the type label (INFO/WARNING/…) with no icon.
Injecting a per-type SVG into a pseudo-element inside a contenteditable is
impractical and was already scoped out in the existing CSS comment, so it is left
as-is and noted here rather than hacked in.

## Verification

- New suites: 16 markdown round-trip + 7 HTML paste parity, all green.
- Editor / renderer / clipboard suites: 1580 tests, green (no regression from the
  `<hr>` change).
- e2e (`toolbar-structural-inserts`, `toolbar-controls`): green — confirms the new
  `@apply` CSS compiles and lists/divider/callout render in the real editor.
- oxlint / oxfmt / tsgo: clean on all changed files.
