# Session 2853 — Ctrl/Cmd+click opens a background tab everywhere; /h1–/h6, /code and /quote clear the list style

Two maintainer decisions on #5691 (2026-10-22).

- **Ctrl/Cmd+click opens a page in a background tab everywhere.** This covers links, the command palette, its recents and the graph. Links and the palette used to focus the new tab. Middle click already opened behind.
  - The palette's action-menu row *Open in new tab* (⌘↵) now opens behind as well. It is the same key as Ctrl+Enter, and every other *Open in new tab* menu row already opened behind.
  - The page header's *Open in new tab* and Ctrl+T still open in front, through `openInNewTab`.
- **A background tab keeps the block a `((ref))` named.**
  - `Tab` gains an optional `blockId`, set by `openInBackgroundTab(pageId, title, blockId?)`.
  - Every path that brings a tab to the front calls `enterTab`, which hands that id to the navigation store's one-shot `selectedBlockId` and then clears it from the tab. Those paths are switching, closing, Back closing a tab, removing pages and reopening a closed tab. Before, each set the selection to `null`, so a Ctrl+clicked ref opened at the top of its page.
  - Renaming a page keeps the id.
- **`/h1`–`/h6`, `/code` and `/quote` clear a block's list style,** as callouts do since #6037. This holds in block mode (`useSlashCommandStructural`) and in page mode (`page-slash-commands.tsx`, through `ctx.clearListStyle`). Ctrl+Alt+1–6 run the same heading handler. The toolbar's Turn into, code-language and callout selectors already cleared it.

Left alone, and why:
- Neither of these is on the slash path, and neither has a block id where it runs:
  - the code-block chord in `CodeBlockWithShortcut`;
  - TipTap's Markdown input rules (`## `, `> `, ```` ``` ````).
- Page mode's `/turn <type>` still writes the list style straight to the backend instead of through `ctx.clearListStyle`, as it did before.

**Shown red:**
- the hook not forwarding `blockId` (unit tests and the e2e Ctrl+click on a ref);
- `enterTab` setting `null`;
- `enterTab` keeping the id on the tab;
- the palette not passing `blockId`;
- `renamePage` dropping it;
- the list-style clear removed from `handleHeading`, from `handleToggleBlock`, and from page mode's slash wiring;
- the palette always opening in front.

**Suites run:**
- vitest over hooks, stores, the palette, common, layout, `src/editor`, block-tree, editor and `src/__tests__` (10,637 passed);
- typecheck and lint;
- `prek run --hook-stage manual --all-files`;
- the import-cycle check;
- Playwright over background tabs, the palette, recents, graph, tabs, slash commands, list style and page mode (197 passed).
