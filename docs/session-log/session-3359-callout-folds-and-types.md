# Session 3359 — Callout folds, hyphenated types and every alias's style (#6033 S9, #6277 C5)

Set out to build #6033 S9 (= #6277 C5). `> [!faq]-` put the `-` into the title, `[!my-type]` did not parse as a callout, and every Obsidian alias and every GitHub or GitLab alert other than the five style names rendered as a note.

**What shipped.** `CALLOUT_RE` takes `[\w-]+` types and an optional `+`/`-` right after `]`, kept as a `calloutFold` attr the serializer writes back (and `block-type-convert`'s marker pattern now matches the parser's). A folded callout's static render shows its header and title (the first child up to its first hard break) with a `ChevronToggle`; `-` starts closed, `+` open, and the open state is view state, never stored. The focused block and page mode show the whole callout. `src/lib/callout-style.ts` maps every documented Obsidian type and alias and GitHub's and GitLab's alerts to the nearest of `CALLOUT_CONFIG`'s five styles (Obsidian's own aliases decide the ambiguous ones: `caution` → warning, `important` → tip); the stored type stays as typed, and the editor CSS keys on a new `data-callout-style`.

**Review fix.** Changing a folded callout's type through the block menu or Turn into dropped its fold; `convertBlockContent` now carries it.

**Kept as is.** The header label and icon are the mapped style's (`[!faq]` reads "Warning"), because #2275 pins unknown types to the Note label; the editing view's CSS label shows the typed type, so the label changes on focus. Showing the typed name title-cased, as Obsidian does, is a follow-up for the maintainer. Notion's import still says Agaric stores no toggle.

**Tests.** Parse, serialize and round-trip seeds, the extension's attrs, the revealed marker, `block-type-convert`, a 34-type render table with `axe`, fold toggle tests, and two new `e2e/callout-roundtrip.spec.ts` tests (folded view, toggle, stored `-` re-queried after navigating away and back). Gates: full vitest in shards, typecheck, lint, all and manual-stage hooks, and 172 callout and page-mode Playwright specs (`e2e-related` selects the whole lane because of `index.css`; CI runs it).
