# Session 2847 — review notes from #6038, #6039, #6041 and #6042

The non-blocking notes left on those PRs, batched into one follow-up.

- **A page preview no longer calls a page empty when only its first blocks are blank.** `fetchPeekTarget` dropped blank blocks after taking five. It now uses the response's `has_more`. It still says *This page is empty.* when nothing follows. When more blocks follow, it says *The first blocks of this page are blank.*
- **A quick tap of Ctrl or Cmd as the pointer crosses a link opens nothing.** A `keyup` of Control or Meta clears the pending 350 ms open. This also applies to block-ref chips.
- **One fix for the stale peek on Ctrl+click.** #6041 and #6042 each fixed it, one with a container-level click stop and one with a window-capture close listener. The window listener stays. `delegatedLinkClickProps` is back to a plain `stopPropagation`, and the test that pinned the container stop is deleted.
- **Page mode memoizes its link-click props.** The React Compiler bails out of `PageModeDocument`, so these were rebuilt on every render. Block mode already memoized them.
- **JEX import warning reworded.** It no longer says "not an image": a link without `!` is never shipped, whatever its type. The warning now counts "linked, not embedded" files.
- **`repair_misfiled_tag_spaces` records its prior the way the central writer does.** It now records `unwrap_or_default()`.
- **jex-import mutation survivors triaged.**
  - Line 120's regex survivor was a real gap: two spaces before a link title. The existing reference-forms test now covers it.
  - Four `flatMap` and fallback survivors are equivalent and are accepted in `mutation-accepted.tsv`.
  - The other listed lines predate #6038.
- **`.nsprc` drops the two extract-zip advisories.** extract-zip is gone from the tree, and the audit reported both entries as matching nothing.

Dropped: hoisting Turndown into `parseJex`. It is a parameter threaded through `htmlToMarkdown`, for a cost nothing shows.

Shown red:
- the preview always saying empty;
- the `keyup` arm removed, and the Meta arm alone removed;
- the window close listener moved to the container (the e2e Ctrl+click spec and a unit test);
- counting only non-image links;
- the regex mutant applied by hand.

Suites run:
- vitest over the changed files, `DataTab`, page mode and `src/__tests__`;
- typecheck and lint;
- 92 Playwright tests over peeks, links, background tabs and page mode;
- `cargo nextest` over the misfiled tests, clippy and fmt;
- `npm-audit-retry.sh`.
