# Session 2841 — Ctrl+click, middle click and Alt+Enter follow links into tabs

Part of #5691's Obsidian parity: opening a link without losing your place.

- **Ctrl/Cmd+click on a page link or block ref opens it in a new front tab.** A block ref lands on its block, the same reveal a plain click gives. Before, a Ctrl+click on a chip navigated in place.
  - The handler is a capture-phase listener on the chip container (`useOpenInBackgroundTab.ts`). It acts only when the click's target is inside a link chip, so a Ctrl+click elsewhere still toggles multi-select.
  - It stops the native click at its own container, not at the React root, so the ref peek's capture listener still sees the click and closes.
- **Middle click** opens a background tab in page mode too, as it already did in block mode.
- **Alt+Enter follows the link at the caret** in block and page mode. It is rebindable as `followLink`. `linkAtCaret` (`revealed-markers.ts`) reads a node selection or a chip on either side of the caret. Away from a link, and while a picker is open, Alt+Enter is plain Enter.
- `tabs.ts`'s `openInNewTab` takes an optional block id.
- `pageLinkIdAt`, the chip lookup the long-press menu and the click handler share, moves to `src/lib/link-chip.ts`, so the hook does not import from `components/` (`lib-layering`).

Reviewed separately; the reviewer was killed by a container restart and continued by a second one.
- **Listed twice.** The catalog had listed "Ctrl + Click" twice with two meanings, so the link entry is dropped. The behaviour stays documented in `tags-and-links.md`, `views.md` and `editor.md`.
- **Plain Enter at a link.** Nothing pinned that it still splits the block; a test now does.
- **Peek with the hover-preview branch.** Checked against the hover-preview branch: with the root-level stop, a Ctrl+hover peek stayed open over the new tab; with the container-level stop it closes.

Shown red:
- foreground turned into background (four tests);
- the `followLink` rule reduced to plain Enter;
- plain Enter at a link following it;
- the container stop moved back to the root (the peek stayed open).

Suites run: vitest over the touched tests, `src/editor`, `src/stores`, `src/components/editor`, keyboard config and `src/__tests__`; typecheck; lint; and 176 targeted Playwright tests, including `e2e/background-tabs.spec.ts`. `just e2e-related` selects the whole lane, so CI's run is the check.

Left for the maintainer: Ctrl+click opens a background tab in the recent-pages strip and the graph, but a front tab on link chips and in the command palette.
