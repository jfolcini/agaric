# Session 4327 — icon labels on touch, shortcuts with a keyboard, no native titles

Last PR of #6895, after #6900 (App health) and #6910 (explanations behind an ⓘ). It covers the rest of the issue: icon names on touch, one hover delay, the native `title`, and the editor's broken link chip.

## What shipped

- **`IconButton` takes `shortcut`.** It shows after the name on a device with a keyboard. A touch-only device (`useIsTouch() && useIsMobile()`) shows the name alone.
  - The formatting toolbar, the Format menu, find-in-page, search, graph and zoom controls, history and journal navigation, and page mode's link bubble move to it. Shortcuts move out of their tooltip strings into `shortcut`.
  - Left as bare Tooltips: block-row controls (collapse, priority, +N properties, refs, attachments, the task checkbox) and the selection bubble menu. A touch test showed the row's long-press (drag activator and block context menu) also fires on them.
- **One hover delay.** Every per-site `delayDuration` is gone; every tooltip takes the user's setting.
- **Native `title` banned.** oxlint `react/forbid-dom-props` covers `title` on any DOM element. `react/forbid-component-props` covers `title` on a component, with an `allowedFor` list of components whose `title` prop never reaches the DOM. Two sanctioned homes:
  - `TruncatedText` (`src/components/ui/truncated-text.tsx`) shows the full text while a line is cut, or when it shows a namespaced page's leaf (bookmarks, tabs, recents). A `text` prop serves rich children (search highlights).
  - Page-link chips keep `title` only when they show a leaf or a label.
  - The rest were burned down. Duplicates of visible text or an `aria-label` are deleted. Truncations use `TruncatedText`. Explanations move to an ⓘ: the agenda's overridden filter, the Templates type badge, the Pages Orphan/Stub facets. The imperative titles in the editor's footnote, block-ref and page-gutter node views are gone. `FilterPill` no longer accepts `title`, so a spread cannot slip one past the lint.
- **Toolbar presses on touch act on release** (`toolbarPressHandlers`).
  - Every press is still `preventDefault`ed on `pointerdown`, so the editor keeps its selection.
  - A mouse acts on the press.
  - A finger acts on its release, unless that hold opened the button's name. Radix marks the open tooltip on the trigger (`data-state`), and that release does nothing.
  - Controls with no name to show (Save, menu rows) act however long the press.
- **Broken `[[link]]` in an editing block.** It opens the static chip's popover (`BrokenBlockLink`, mounted from the node view with `ReactRenderer`), with `data-editor-portal`. Its Remove re-resolves the node at the press: it does nothing and warns if the node has gone or is no longer broken. Removal is still one undoable step.

## Traps

- **Duration timing in the toolbar.** The first cut of "a hold does nothing" measured the press duration in the shared handler. That also dropped slow taps on Save, Cancel and menu rows, where a hold shows nothing. Reading the tooltip's state ties the rule to what the user saw.
- **A full-title chip has no title.** Real-backend import specs checked a link's target by its chip `title`. Chips showing their full title no longer carry one, so `linkChipTarget` (e2e-tauri/helpers.ts) reads the title or else the text. Page rows are selected by `data-page-title`.
- **One Playwright run per worktree.** A second Playwright run in the same worktree rebuilds `dist/` under the first one's server. Its later tests then fail in under a second each. That run was discarded and re-run alone.
- **Chromium keeps the selection without the guard.** In touch emulation the editor kept its selection even without the touch `preventDefault`, so only the unit test pins that guard.

## What ran

- Full vitest, typecheck and oxlint over src, e2e and e2e-tauri, all green. Every new or changed test was shown red by breaking the code it covers, each in one restoring command.
- Playwright: the 214 related specs. The 81 files the first, discarded run hit were re-run alone, 458 passed. The new `e2e/toolbar-touch-labels.spec.ts` covers a hold and a tap on a phone and a hover on desktop. The broken-chip editing cases in `e2e/link-chip-lifecycle.spec.ts` run on a phone and on desktop.
- Not run locally: the WebdriverIO real-backend lane (CI's e2e-tauri-gate).
