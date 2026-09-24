# Session 1816 — markdown source mode, phase 5

Phase 5 of #5140 is the last one. It adds a **Merge** action to the "This page changed" dialog of *Edit as Markdown* (4b, #5157). Before it, a stale save could only reload the page, overwrite what changed there, or keep editing. Merge saves the buffer with the page's changes folded in, as one undo entry, then closes source mode like a Save.

**How it merges.** `apply_page_source` gains `merge: bool`. A stale save without it is refused with `RequiresRefresh` as before. With it, the buffer is replaced by `merge_outlines(base, current, buffer)`, in the same transaction that writes it, before `pair_blocks`. Everything after that runs unchanged: names, placement, writes, deletes, the op cap, the depth cap and the nested-page refusal.
- **Blocks pair by `^ID` anchor.** Content and each property follow one rule: the side that changed wins. Multi-line content also tries a line merge (`merge_lines`, over `similar::TextMerge`).
- **A block both sides changed differently** keeps the page's version. The buffer's version is saved directly before it as a new block, and a warning names it. Nothing typed is lost, and no conflict markers reach the text.
- **Deletes give way to edits.** A buffer delete of a block the page edited is not applied. A page delete of a block the buffer edited brings the buffer's version back as a new block. Each case adds a warning.
- **Parents and order merge three ways.** A block whose parent is gone is lifted to its nearest kept ancestor. A move that would put a block under its own descendant keeps the page's parent, with a warning. Without that guard, both blocks would be unreachable and deleted.
- `merge: true` on a fresh base is exactly a plain save.

**Changed from the plan.**
- **Merge closes source mode like Save**, rather than reloading the merged result into the buffer. The tree shows both versions of a conflicted block next to each other.
- **The plan's example `merge_lines("a\nb", "A\nb", "a\nB") == "A\nB"` is wrong for `similar`.** It treats edits that touch at a line boundary as one conflicting region, as git's xdiff does, so that case forks. The test pins both the touching case and a disjoint one.
- **The mock ports the merge for content, depth and anchors.** Where the backend would line-merge a multi-line block, the mock forks. The code marks that as a deliberate approximation, and the fixture avoids it.

**Review.** An independent reviewer traced every row of the merge table, the parent merge and the order merge. It ran nine extra probes; each landed as designed, with nothing lost. It fixed four things:
- **The dialog's primary action is now last and focused on open**, as in every other dialog, with the destructive Overwrite farthest from it.
- **4b's Playwright `toBeHidden()` on the textarea passed while the dialog hid it from the accessibility tree.** The spec now asserts that the source editor is gone.
- **The fixture lacked the one row where Merge overrides what the user did**: a delete that gives way to an edit on the page. A step now pins it on both sides.
- **Why a line-merged block is code when either side's was** now has a comment. It decides whether a `#tag` in the merged text creates a tag.

**Verified.**
- `cargo nextest run --workspace` ran 6489 tests with 0 failures, split in two. Artifact mtimes were checked around both halves, to rule out another checkout's build.
- Clippy, fmt and the rustdoc link check are clean. Both sides pass the conformance fixture, the TS side 228 of 228.
- The whole vitest suite passed 19616 tests (860 files). `npm run typecheck` and `npm run typecheck:e2e-tauri` pass.
- Playwright `page-source-edit` passed 5 of 5.
- Each of these mutations, applied to a copy, turned its targeted tests red:
  - keeping the page's version with no fork;
  - dropping the cycle guard or the lifting;
  - either fixed order skeleton;
  - a delete on either side that ignores the other side's edit;
  - leaving source mode open after Merge;
  - Merge first in the footer, or not focused.
- `e2e-tauri/page-source-merge.e2e.ts` typechecks, but only CI can run it. It edits one block through the real IPC, edits another in the buffer, then merges and reopens the page.
