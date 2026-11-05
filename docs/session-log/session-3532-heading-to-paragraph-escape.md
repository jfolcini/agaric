# Session 3532 — Turn into Paragraph keeps a numbered heading a paragraph (#6370)

Fixed #6370. The review-notes sweep for #6343 found it.

**The bug.** Turning `# 1. groceries` into a paragraph stored `1. groceries`, which reads back as a one-item ordered list. `# - to buy`, `# * x`, `# + x` and a quote's `> - x` behaved the same way.

**The decision.** It was relayed from the maintainer through the coordinator session: escape the marker, and update #4552's pinned assertions in `block-type-convert.test.ts` to the escaped form.

**What shipped.**
- `convertBlockContent` now escapes a leading `1. `, `- `, `* ` or `+ ` when the target is a paragraph or a list kind. These targets keep their list-ness in `listStyle`, not in the text.
- The source buffer writes its own escapes. Its Turn into therefore calls the unescaped `convertBlockText`, so it doesn't escape twice, and its fence test keeps `\- x`.

**Tests.**
- A case per marker asserts both the stored form and that it parses back as a paragraph. A further case keeps text like `1.5 kg` and `-minus` unescaped.
- The red run before the fix failed the 8 predicted cases, and removing the escape again reds the same 8.
- Gates: vitest over `src/lib`, `src/components` and `src/editor` (21772 passed), typecheck, oxlint.
