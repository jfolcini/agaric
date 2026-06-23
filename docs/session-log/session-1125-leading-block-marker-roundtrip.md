# Session 1125 — editor: blocks starting with `>` / `---` corrupted on save

User reported: "trying to save a block that starts with a tag fails, fix that and
check with all other special marks or characters."

## Root cause

A block is saved by serializing the editor doc to markdown (`getMarkdown` →
`serialize`) and the markdown is reparsed on the next load. `serializeParagraph`
escapes a leading block marker so a paragraph can't be promoted to another block
type, but it only covered `# ` (heading), `N. ` (ordered list) and `- ` (bullet).
Other line-start block productions were unescaped, so a paragraph whose text began
with them drifted to a different block type on the round-trip:

- `> ` or a bare `>` → reparsed as a **blockquote**.
- a line of 3+ dashes (`---`) → reparsed as a **horizontal rule** (content lost —
  HR has no inline content).

The **tag itself was never the problem**: a `tag_ref` (`#[ULID]`) at block start
round-trips fine (`#` is only a heading marker when followed by a space; the chip
serializes as `#[`). The actual defect is the broader "block starts with a special
marker" class the user pointed at.

## Shipped

- `src/editor/markdown-serialize.ts` — `serializeParagraph` now also escapes a
  leading all-dashes run (`---` → `\---`, reusing the existing `\-` escape) and a
  leading blockquote marker (`> `/`>` → `\> `/`\>`).
- `src/editor/markdown-parse/parser.ts` — `isEscapableChar` now accepts `\>`
  (symmetric with how `-` was made escapable in #1436). No serializer output ever
  emitted a literal `\>` before, so accepting it cannot break an existing pair.

## Verification

- New regression test `src/editor/__tests__/leading-block-markers.test.ts`: a
  paragraph starting with each block marker / special character (`#`, `1.`, `-`,
  `*`, tasks, `>`, `---`, `***`, `___`, fences, `$$`, tables, callouts, `+`, and
  the tag chip) must reparse to a paragraph, value-preserving and idempotent — 26
  cases.
- Full editor suite green (1550 tests), including the randomized round-trip
  property test.
