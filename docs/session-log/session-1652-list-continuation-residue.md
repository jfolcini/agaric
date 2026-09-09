# Session 1652 — two spaces that were never text

Importing a 4-space continuation line under a list item kept two of the spaces
as paragraph text: `- item\n    continued` parsed to `p('  continued')`.

## Where the two spaces came from

`collectListItem` dedents a nested line by exactly one content column. For a
4-space continuation that leaves two columns, and the parser stored them.
They were never text — they are what is left of an indent after the item's own
indent is removed.

The fix is not to dedent differently. It is that what the dedent leaves on a
**paragraph** line is indentation, not content: `parseParagraph` takes an
`indentIsStructure` flag that only the recursive parse of a list item's nested
lines sets. Fenced code and math are untouched, because their interior lines
really are content.

## Why the cheap trim alone does not work

`- x\n    a` is byte-identical to our own output for a nested paragraph whose
text genuinely starts with two spaces. Trimming on its own reddens the pinned
#4019 fixpoint and buried-marker properties — it would silently eat real
leading whitespace on export/import round trips.

So the other half is the serializer. `serializeBlockSequence` already defuses
leading whitespace with a `\` escape for two hazards; this is the third: every
line of a list item's non-leading child, at any indent, with no threshold —
one space is already enough to be lost. Content whitespace therefore comes
back through the escape (`- x\n  \ a`), and raw whitespace on such a line can
only be the foreign document's.

## The two consequences, stated rather than discovered later

1. The residue also disappears in the pinned 6/8-space marker case:
   `parse('- parent\n      - child')` now stores `p('- child')`, was
   `p('    - child')`. The pinned *decision* — a paragraph, not a sub-list — is
   unchanged and its tests still assert it; only the residue moved, by the same
   arithmetic this issue is about.
2. The emitted bytes change for a nested paragraph starting with whitespace:
   `- x\n   a` becomes `- x\n  \ a`. Stored content in the old form imports once
   with the leading spaces dropped — a one-way, then-stable conversion, and the
   trade this fix makes in favour of foreign markdown.

## Deliberately not done

Lazy continuation — the continuation line *joining* the item's paragraph. The
issue names it as the genuinely correct fix and also as a parser-semantics
change of its own. A 4-space continuation still becomes a second paragraph,
now without the residue, and `list-ergonomics.md` still records that half as
unimplemented.

## Verification

Three mutations, each restored from a copy and `cmp`-proven:

- parser trim disabled — 8 of the 11 new tests red;
- the trim moved into `collectListItem` (every nested line, the wrong
  placement) — the item-nested code block loses its indentation;
- serializer defuse disabled — 8 red, including the #4019 fixpoint, the
  buried-marker property, and the serialize→parse→serialize fixpoint.

The middle one is the one worth keeping: it is the fix that looks right and
breaks code blocks.

`src/editor/__tests__/` 2037 passed across 48 files, including the five
5000-run property sweeps. Typecheck clean; the new regex is `^`-anchored, so
the unanchored-content-regex guard passes.

Closes #4050.
