# Session 3433 — A heading's text gets no block-marker escape (#6277 C3)

Set out to build the three small round-trip defects the C3 survey found, which the maintainer asked to land first: an ordered list's start, a callout's type case, and a heading's needless escape.

**What shipped.** `### 1. Clean up` (and `### - x`, `### > x`, `## # x`) was written back with a backslash, because the line-start block-marker escape also fired inside a heading, whose production (`parseHeading`, Rust's `Scan::heading`) reads its text as inline only. `serializeParagraph` now takes `lineStart: 'block' | 'behind-marker' | 'inline'` in place of `atLineStart`, and a heading passes `inline`. Table cells and list-marker lines keep their first-line escape. One existing assertion pinned the needless escape: `page-lists.test.tsx` `'# \\- zTitle'` is now `'# - zTitle'`.

**Not shipped, back to the maintainer** (#6277 comment 6641798551). An ordered list's start conflicts with the documented design in `list-ergonomics.md` §3 (numbers come from position, never stored), and six tests assert the renumbering. A callout's type is lowercased by design on read, and keeping the typed case fails 39 tests in 9 files. Each is either a reviewed `editorCanonical` row or a design change.

**Trade.** Turn into Paragraph on `# 1. groceries` now gives `1. groceries`, which reads as a list, for an edited heading as well as an imported one. #4552 pins that on purpose: a block's text may start with `1. ` once its real marker is stripped.

**Tests.** Round-trip seeds in `markdown-roundtrip.property.test.ts`, red on the base for the four shapes. The review probed 117 heading shapes at h1, h3 and h6, including hard breaks and blockquotes. Gates: editor, lib and components vitest, typecheck, lint, all hooks, and 119 heading and page-mode Playwright tests.
