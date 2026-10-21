# Session 2837 — turning a list block into a callout drops its bullet

Found in #5691's 2026-10-21 review. Turn into → Callout on a bulleted or numbered block kept its `listStyle`, so the callout still drew a bullet or a number. Every other Turn-into target clears it.

All three callout paths now clear it, the way `handleTurnInto` does:

- **The page-mode block menu and slash `/callout`, `/callout-*`.** `handleCallout` writes the content and then `listStyleForBlockType('callout')`.
- **The toolbar's callout picker.** `INSERT_CALLOUT`'s listener does the same.

Each path toasts `slash.calloutFailed` once if the style write fails.

In page mode, `/callout` and `/callout-*` leave the run-at-once list and run after the save, as the `page-slash-commands.tsx` docblock requires of a command that writes a list style. Otherwise the clear could reach a block the backend had not created yet. The page shows the plain text for one save round trip; text typed meanwhile lands inside the callout. The parity test pins the move.

Reviewed separately:
- **Missing block.** The real backend's `delete_property` gives `NotFound` for a missing block. The mock does not check, which is why vitest cannot show it.
- **Undo.** One Ctrl+Z takes back the same as Turn into.
- **Rejection tests.** The reviewer added the missing tests for both new `catch` branches.

Shown red:
- the clear deleted from `handleCallout`: block-mode, page block menu and page-mode tests failed on `expected 'bullet' to be 'none'`, and `page-mode-block-menu.spec.ts` on `Received: "bullet"`;
- the clear deleted from `onCallout`: the listeners test failed;
- each toast removed, or fired on success.

Suites run: vitest over block-tree, editor, components/editor and editor-toolbar (6586 passed), typecheck, lint, `prek` manual stage, and the Playwright specs `just e2e-related` selects. Three specs that also fail on `origin/main` in this container (`block-line-break.spec.ts` iPhone "New line", `diagram-legibility.spec.ts` label width) were left to CI.

Left as is: slash `/h1`–`/h6`, `/quote`, `/code` and `/divider` keep a list style, unlike Turn into. Whether slash formatting should clear it is a product call; toolbar Turn into → Code (`CodeLanguageSelector`) has the same gap and is in the follow-up notes.
