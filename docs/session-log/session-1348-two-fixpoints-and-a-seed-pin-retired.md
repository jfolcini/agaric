# Session 1348 — two fixpoints, and the seed pin they were holding open

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | 1 (resumed from an interrupted session) |
| **Items closed** | `#4072` |
| **Items filed** | `#4156` |

**Summary:** #4072 bundled two rare round-trip violations that the #4059 sweep had
found and left live. Fixing them turned out to be the precondition on a comment
already in the tree: `markdown-roundtrip.property.test.ts` carried a fast-check seed
pin whose docstring said, in as many words, "delete the pin when violations 2 and 3
are fixed, not before". So the session's real deliverable is not two one-line
matchers — it is that the file explores randomly again.

### The two violations

**A callout-shaped link.** A link whose visible text begins with `!` serializes to
`[!a](https://example.com)` — character-for-character a `[!TYPE]` callout marker with a
destination glued on. Leading a blockquote it re-parsed as a callout named `a`, so the
label was upper-cased and `serializeBlockquote` re-emitted it as `[!A] (…)`. The
inserted space is what makes this more than cosmetic drift: it breaks the link.

The two productions differ at exactly one character. A callout's `]` is followed by end
of line, whitespace, or its title — never by the `(` that opens a link destination — so
`CALLOUT_RE` now refuses that one follower and nothing else about callout syntax
narrows.

**A cell edge that two frames disagreed about.** A markdown table cell is single-line,
so a hardBreak inside one degrades to a space, and `parseTable` trims the cell on both
edges. Those two rules ran in the wrong order. The break became a space at the node
level; `serializeParagraph` then saw a paragraph beginning with a space and declined to
escape the block marker behind it; and only afterwards did the string `.trim()` pull
that space off, emitting a bare `>` at the cell edge. The reparse stores the marker as
plain text, whose own serialization *does* escape it — so pass one wrote `| > |` and
pass two `| \> |`, forever.

The trim now happens at the node level, before any escaping decision, so the paragraph
the escape logic inspects is the one the parser will actually store back. Whitespace
inside a mark's delimiters is content, not a cell edge, and is left alone.

### The third file nobody had cited

`src/lib/block-type-convert.ts` keeps its own callout matcher for the Turn-into menu.
Fixing the parser without it would have *created* a divergence: the editor renders
`> [!a](url)a` as a plain quote holding a link, while the menu would still highlight
"Callout" and `stripBlockMarker` would eat the `[!a]` that *is* the link's text. Both
patterns there are now built from one shared fragment, and the test that matters is the
cross-check — same string, same verdict on both sides — not a restatement of the regex.

### Retiring the seed pin

The pin was added by #4059 because unseeded exploration would eventually surface three
pre-existing violations on an unrelated contributor's PR. #4071 fixed the first; these
two were the other two. The evidence bar for removing it was set by the sweep that
justified adding it (10 seeds × 20 000 runs), and was cleared with room: 32 distinct
seeds × 20 000 runs, 640 000 runs, green across all 42 tests — with the *same* sweep
reddening at seeds 1, 6, 9, 10 and 12 on the parent commit, which is what makes the
green mean something rather than merely being green.

### What the exhaustive sweep actually measured

The convergence sweep ran before and after over the same corpus — six alphabets, both
free and prefix-anchored, plus a seeded random corpus, 1 607 480 inputs in total. 616
non-convergent before, 21 after, and zero inputs that converged before and stopped
converging after. That last number is the one the fix had to earn; the other two only
say how much ground it covered.

The 21 survivors are one family, unrelated to either violation here and present
identically on both sides: an emphasis span wrapping only whitespace. `*\ *` parses to
italic-marked `" "`, serializes to `* *`, and `* *` is a bullet list — so the second
pass writes `- \*`. Filed as #4156 rather than folded in, because a fix there is about
the serializer refusing to emit a mark whose content cannot survive re-reading, which is
a different question from where a cell's edge is.

### Process note

This session resumed an interrupted one whose work was intact on disk. Two things the
predecessor had left were worth keeping and two were not: the fix and its tests were
correct and stayed; the throwaway sweep harness was deleted as intended; and the
`SWEEP_SEED` env override it had added to reach the sweep was retired along with the pin
it parameterized, while `SWEEP_RUNS` stayed and is now documented, because the two
run-count comments in that file both ask for a by-hand sweep and neither said how. The
predecessor also never ran `tsc` — the override it added failed `noPropertyAccessFromIndexSignature`.
