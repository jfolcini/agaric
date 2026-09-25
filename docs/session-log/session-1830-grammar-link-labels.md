# Session 1830 — link labels (#5160 Phase 3b)

Phase 3b of #5160: decision D9 (store the label) and N6. `[[Page|label]]` used to create a page titled `Page|label`. It now links Page, keeps the label as `[[ULID|label]]`, and follows renames.

**What changed.**
- **Every reader knows the label.** That covers the link graph and backlinks, FTS (the label is what a reader sees), export, Source and clipboard (`[[Title|label]]`), the TS parser, serializer and link node, the static chip, the mock, the empty-block guard and the cross-space audit.
- **A label equal to the target's title is not stored.** A `]` typed into a label is dropped, because every reader would turn `[[ULID|[WIP] x]]` into text.
- **A `|` inside a page title is read before the label.** This is D10's "exact title first", applied to `|`:
  - The candidates are the whole body, then each `|`-prefix, longest first.
  - The first candidate that names an existing page wins, and the rest is the label.
  - A tie leaves the text, with a warning.
  - Only the first-`|` split can create a page.

  This came from review. Without it, a link to `Article | Medium` read back as page `Article` labelled `Medium` on export, copy, paste, the picker and every Source save. JEX imports `|`-titled notes first so that links to them resolve.
- **Paste, import and Source** read `[[Title|label]]` and Logseq's `[label]([[Page]])`. A relative `.md` link on a folder import keeps its text as the label.
- **The editor.** Typing `[[Page|label]]` links Page with the label, and `[[Page#Heading]]` never creates `Page#Heading`. The link popover edits a chip's label.
- **Unlinked References.** "Link it" no longer splices into another link's label.
- **Not built:** D10's cross-page anchors (`[[A#Heading]]` becoming a block ref, and `[[Page#^id]]`). Such a link still resolves to the page, with the "anchors dropped" warning.

**Review.** Two independent reviewers each ran the full suite and broke the claims on copies (8 mutations on the labels, 18 on the `|` rule, each turning a test red).
- **Fixed, with tests shown red first:**
  - the audit's regex missed labelled links;
  - "Link it" corrupted another link;
  - a `]` in a label turned the link into text;
  - the `|`-in-title regression.
- **Open product question:** a block that mentions a page only inside another link's label still lists under that page's Unlinked References, because the label is search text. "Link it" there now shows the "link failed" toast instead of corrupting the other link.
- **Known limits:**
  - A `|`-titled JEX note that links to another `|`-titled note imported after it still splits.
  - Picking a `|`-titled page from the popup after typing an anchor ignores the anchor.

**Verified.**
- `cargo nextest run --workspace`: 6575 passed. Doc-tests pass; clippy and fmt are clean.
- The four `sqlx prepare --check` lanes pass.
- vitest: all 852 files green.
- The three typechecks are clean.
- Playwright: 122 passed across the link, picker, paste, import/export, Source and search specs.
- After the rebase onto #5174, `paste_blocks.json` was re-authored by the backend. Positions shifted by one, and the labelled-link paste gained its rows and `page_link` edges. The targeted run was 1391 nextest tests plus 1502 vitest tests.
