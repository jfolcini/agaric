# Session 1833 — `[[Page#Heading]]` into another page (#5160 D10)

The last part of Phase 3b: decision D10's anchors into another page. Before this, `[[Guide#Setup]]` from another file always linked the page `Guide` and warned that the anchor was dropped.

**What changed.**
- **Headings.** A `[[A#Heading]]` whose base is another existing page, when no page is titled `A#Heading`, is a `((ULID))` ref to A's only heading with that text. The text is compared as the same-file pass compares it, with case and spacing folded. Two such headings, or none, link the page with the "anchors dropped" warning.
- **Block ids.** `[[A#^id]]` refs A's block with that id. That is the form export writes for a ref to another page's block, so an Export → Import round trip now keeps a cross-page block ref instead of degrading it to a page link.
- **Obsidian `^name` anchors are not stored after import, so they still link the page with the warning.** Resolving them across files would need somewhere to keep the anchor (a property), which is the maintainer's call.
- **Labels.** A label on such a link is dropped with Phase 3b's warning, since a block ref carries no label.
- **Where it applies.** Import, paste and Edit as Markdown share one batched read over `blocks`, by the denormalised `page_id`.
- **A label equal to the title.** A same-file anchor that matches nothing links the page without a label equal to the page's title (a Phase 3b review note).
- **Warnings.** The two anchor warnings no longer claim cross-note targeting is unsupported.

**Review.** An independent reviewer ran the full suite and broke the claims on copies; the builder had broken 15 before that. It found no correctness defect in the D10 logic.
- It fixed the two warnings that had become false.
- Two mutants survived. One restricted the heading prefilter to `##` and deeper; the fixture heading is now an h1, and that mutant goes red. The other, `ltrim` in the prefilter, is left: nothing writes a heading with leading whitespace.

**Worth knowing:**
- In paste and Edit as Markdown, an anchor into the page being written stays literal with no warning, as before. Only import runs the same-file pass.
- On a vault import, `[[A#Heading]]` resolves only if `A.md` was imported first. Otherwise the link goes to A's placeholder page and is not revisited.
- The editor's typed `[[Page#Heading]]` still links the page, since resolving the heading there needs an extra IPC per link.
- The mock doesn't model anchors; its waiver says so.
- One import can show the "label(s) were dropped" warning twice, once per pass, each with its own count.

**Verified.**
- `cargo nextest run --workspace`: 6616 passed. Doc-tests: 10 passed. clippy and fmt are clean.
- The four `sqlx prepare --check` lanes pass (one new root query), and `ts_bindings_up_to_date` passes.
- vitest: 19607 passed across 853 files. `npm run typecheck` is clean.
- Playwright: 68 passed across nine import, Source, paste and link specs.
- After the h1 fixture change: the 72 anchor and heading tests passed.
