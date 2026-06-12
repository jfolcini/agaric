/**
 * Static catalog of keyboard shortcuts (MAINT-127).
 * Owns the `ShortcutBinding` shape and the `DEFAULT_SHORTCUTS` array — the
 * canonical, unmodified default bindings keyed by stable shortcut id.
 */

export interface ShortcutBinding {
  id: string
  keys: string
  category: string // i18n key
  description: string // i18n key
  condition?: string // i18n key
  /**
   * `false` marks a documentation-only entry: the trigger is hardcoded at
   * its consumption site (mouse chords, TipTap input-trigger characters,
   * structural editor keys with positional conditions) and is NOT routed
   * through `matchesShortcutBinding`/`getShortcutKeys`. The Settings tab
   * hides the edit affordance for these (#724 — never advertise a rebind
   * that won't be honoured). Omitted (default) means the binding is
   * genuinely rebindable; a drift test pins this flag against the actual
   * consumption sites in `src/`.
   */
  rebindable?: false
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  // Navigation — documentation-only (#724): positional editor keys
  // (arrows/Enter/Backspace gated on cursor position) handled by the
  // KEY_RULES table in `editor/use-block-keyboard.ts`, not the matcher.
  {
    id: 'prevBlock',
    keys: 'Arrow Up / Left',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToPreviousBlock',
    condition: 'keyboard.condition.atStart',
    rebindable: false,
  },
  {
    id: 'nextBlock',
    keys: 'Arrow Down / Right',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToNextBlock',
    condition: 'keyboard.condition.atEnd',
    rebindable: false,
  },

  // Editing
  {
    id: 'saveBlock',
    keys: 'Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.saveBlockAndClose',
    rebindable: false,
  },
  {
    id: 'deleteBlock',
    keys: 'Backspace',
    category: 'keyboard.category.editing',
    description: 'keyboard.deleteBlock',
    condition: 'keyboard.condition.onEmptyBlock',
    rebindable: false,
  },
  {
    id: 'mergeWithPrevious',
    keys: 'Backspace',
    category: 'keyboard.category.editing',
    description: 'keyboard.mergeWithPrevious',
    condition: 'keyboard.condition.atStartOfBlock',
    rebindable: false,
  },
  {
    id: 'indentBlock',
    keys: 'Ctrl + Shift + Arrow Right',
    category: 'keyboard.category.editing',
    description: 'keyboard.indentBlock',
  },
  {
    id: 'dedentBlock',
    keys: 'Ctrl + Shift + Arrow Left',
    category: 'keyboard.category.editing',
    description: 'keyboard.dedentBlock',
  },
  {
    id: 'cycleTaskState',
    keys: 'Ctrl + Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.cycleTaskState',
  },
  {
    id: 'collapseExpand',
    keys: 'Ctrl + .',
    category: 'keyboard.category.editing',
    description: 'keyboard.collapseExpandChildren',
  },
  {
    id: 'moveBlockUp',
    keys: 'Ctrl + Shift + Arrow Up',
    category: 'keyboard.category.editing',
    description: 'keyboard.moveBlockUp',
  },
  {
    id: 'moveBlockDown',
    keys: 'Ctrl + Shift + Arrow Down',
    category: 'keyboard.category.editing',
    description: 'keyboard.moveBlockDown',
  },
  {
    // Documentation-only: TipTap's built-in hard-break keymap.
    id: 'insertLineBreak',
    keys: 'Shift + Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.insertLineBreak',
    condition: 'keyboard.condition.inEditor',
    rebindable: false,
  },

  // Block Tree
  {
    // D1 (#217): zoom IN to the focused block. Zoom-out has Escape
    // (`zoomOut` below); zoom-in was previously context-menu-only. `Alt + .`
    // is layout-stable (Alt does not mutate `KeyboardEvent.key`, unlike
    // `Shift + .` → `>`), free, and pairs mnemonically with the Ctrl+.
    // collapse/expand binding. Only acts when a block is focused and that
    // block has children (a leaf has nothing to zoom into).
    id: 'zoomIn',
    keys: 'Alt + .',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.zoomIn',
    condition: 'keyboard.condition.onFocusedParentBlock',
  },
  {
    id: 'zoomOut',
    keys: 'Escape',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.zoomOut',
    condition: 'keyboard.condition.whenZoomed',
  },
  {
    id: 'openDatePicker',
    keys: 'Ctrl + Shift + D',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.openDatePicker',
  },
  {
    id: 'openPropertiesDrawer',
    keys: 'Ctrl + Shift + P',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.openPropertiesDrawer',
  },
  {
    id: 'heading1',
    keys: 'Ctrl + 1',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading1',
  },
  {
    id: 'heading2',
    keys: 'Ctrl + 2',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading2',
  },
  {
    id: 'heading3',
    keys: 'Ctrl + 3',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading3',
  },
  {
    id: 'heading4',
    keys: 'Ctrl + 4',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading4',
  },
  {
    id: 'heading5',
    keys: 'Ctrl + 5',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading5',
  },
  {
    id: 'heading6',
    keys: 'Ctrl + 6',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.heading6',
  },

  // Pickers — documentation-only (#724): suggestion-plugin trigger
  // CHARACTERS compiled into the TipTap extensions, not keyboard chords.
  {
    id: 'tagPicker',
    keys: '@',
    category: 'keyboard.category.pickers',
    description: 'keyboard.tagPicker',
    condition: 'keyboard.condition.inEditor',
    rebindable: false,
  },
  {
    id: 'blockLinkPicker',
    keys: '[[',
    category: 'keyboard.category.pickers',
    description: 'keyboard.blockLinkPicker',
    condition: 'keyboard.condition.inEditor',
    rebindable: false,
  },
  {
    id: 'blockRefPicker',
    keys: '((',
    category: 'keyboard.category.pickers',
    description: 'keyboard.blockRefPicker',
    condition: 'keyboard.condition.inEditor',
    rebindable: false,
  },
  {
    id: 'slashCommand',
    keys: '/',
    category: 'keyboard.category.pickers',
    description: 'keyboard.slashCommandMenu',
    condition: 'keyboard.condition.inEditor',
    rebindable: false,
  },

  // Journal
  {
    id: 'prevDayWeekMonth',
    keys: 'Alt + ←',
    category: 'keyboard.category.journal',
    description: 'keyboard.previousDayWeekMonth',
  },
  {
    id: 'nextDayWeekMonth',
    keys: 'Alt + →',
    category: 'keyboard.category.journal',
    description: 'keyboard.nextDayWeekMonth',
  },
  {
    id: 'goToToday',
    keys: 'Alt + T',
    category: 'keyboard.category.journal',
    description: 'keyboard.goToToday',
  },
  {
    id: 'createJournalBlock',
    keys: 'Enter / n',
    category: 'keyboard.category.journal',
    description: 'keyboard.createJournalBlock',
    condition: 'keyboard.condition.emptyDaily',
  },

  // Block Selection
  {
    // Documentation-only: mouse chord, not a keyboard event.
    id: 'toggleBlockSelection',
    keys: 'Ctrl + Click',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.toggleBlockSelection',
    rebindable: false,
  },
  {
    // Documentation-only: mouse chord, not a keyboard event.
    id: 'rangeSelectBlocks',
    keys: 'Shift + Click',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.rangeSelectBlocks',
    rebindable: false,
  },
  {
    // #922 — keyboard range-select. Documentation-only: the Shift+Arrow
    // trigger is hardcoded in `useBlockTreeKeyboardShortcuts` (positional,
    // block-select-mode-only) and NOT routed through matchesShortcutBinding,
    // like the positional Enter/Backspace navigation rules.
    id: 'extendSelectionDown',
    keys: 'Shift + Arrow Down',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.extendSelectionDown',
    condition: 'keyboard.condition.notEditing',
    rebindable: false,
  },
  {
    // #922 — see `extendSelectionDown`. Documentation-only mirror upward.
    id: 'extendSelectionUp',
    keys: 'Shift + Arrow Up',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.extendSelectionUp',
    condition: 'keyboard.condition.notEditing',
    rebindable: false,
  },
  {
    id: 'selectAllBlocks',
    keys: 'Ctrl + A',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.selectAllBlocks',
    condition: 'keyboard.condition.notEditing',
  },
  {
    id: 'clearSelection',
    keys: 'Escape',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.clearSelection',
    condition: 'keyboard.condition.withSelection',
  },
  // #913 — block cut/copy/paste as indented-markdown subtrees. Gated on a
  // block selection with NO editor focused (otherwise the browser owns the
  // native text copy/cut/paste), so they never collide with in-editor Ctrl+C/
  // X/V despite sharing the conventional chords.
  {
    id: 'copyBlocks',
    keys: 'Ctrl + C',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.copyBlocks',
    condition: 'keyboard.condition.withSelection',
  },
  {
    id: 'cutBlocks',
    keys: 'Ctrl + X',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.cutBlocks',
    condition: 'keyboard.condition.withSelection',
  },
  {
    id: 'pasteBlocks',
    keys: 'Ctrl + V',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.pasteBlocks',
    condition: 'keyboard.condition.withSelection',
  },

  // Undo/Redo
  {
    id: 'undoLastPageOp',
    keys: 'Ctrl + Z',
    category: 'keyboard.category.undoRedo',
    description: 'keyboard.undoLastPageOp',
    condition: 'keyboard.condition.outsideEditor',
  },
  {
    // `Ctrl + Shift + Z` is the Linux/Windows redo convention; both
    // alternatives were always honoured by the handler — listing both
    // keeps the catalog truthful now that the handler routes through
    // `matchesShortcutBinding` (#724).
    id: 'redoLastUndoneOp',
    keys: 'Ctrl + Y / Ctrl + Shift + Z',
    category: 'keyboard.category.undoRedo',
    description: 'keyboard.redoLastUndoneOp',
    condition: 'keyboard.condition.outsideEditor',
  },

  // List Selection (shared by Trash View & History View)
  {
    id: 'listToggleSelection',
    keys: 'Space',
    category: 'keyboard.category.listSelection',
    description: 'keyboard.listToggleSelection',
    condition: 'keyboard.condition.listItemFocused',
  },
  {
    id: 'listSelectAll',
    keys: 'Ctrl + A',
    category: 'keyboard.category.listSelection',
    description: 'keyboard.listSelectAll',
  },
  {
    id: 'listClearSelection',
    keys: 'Escape',
    category: 'keyboard.category.listSelection',
    description: 'keyboard.listClearSelection',
    condition: 'keyboard.condition.hasSelection',
  },

  // History View
  {
    // Documentation-only: mouse chord, not a keyboard event.
    id: 'histRangeSelect',
    keys: 'Shift + Click',
    category: 'keyboard.category.historyView',
    description: 'keyboard.rangeSelect',
    rebindable: false,
  },
  {
    id: 'histRevertSelected',
    keys: 'Enter',
    category: 'keyboard.category.historyView',
    description: 'keyboard.revertSelected',
  },
  {
    // Documentation-only: list navigation lives in the shared
    // `useListKeyboardNavigation` hook (arrows/Home/End/PageUp/PageDown),
    // which many list surfaces hardcode.
    id: 'histNavigateItems',
    keys: 'Arrow Up / Arrow Down',
    category: 'keyboard.category.historyView',
    description: 'keyboard.navigateItems',
    rebindable: false,
  },
  {
    // Documentation-only: vim-style aliases inside the same shared hook.
    id: 'histNavigateVim',
    keys: 'j / k',
    category: 'keyboard.category.historyView',
    description: 'keyboard.navigateItemsVim',
    rebindable: false,
  },

  // Global
  // PEND-52 — Ctrl+F reclaims the universal in-page-find binding;
  // the global find-in-files view moves to Ctrl+Shift+F (matching VSCode).
  {
    id: 'findInPage',
    keys: 'Ctrl + F',
    category: 'keyboard.category.global',
    description: 'keyboard.findInPage',
  },
  {
    id: 'focusSearch',
    keys: 'Ctrl + Shift + F',
    category: 'keyboard.category.global',
    description: 'keyboard.focusSearch',
  },
  // PEND-51 — Cmd/Ctrl+K opens the quick-navigation palette. Distinct
  // from `focusSearch` (the find-in-files view) and `findInPage` (the
  // in-page find toolbar) — the three keyboard surfaces map 1:1 to the
  // three search surfaces.
  {
    id: 'paletteOpen',
    keys: 'Ctrl + K',
    category: 'keyboard.category.global',
    description: 'keyboard.paletteOpen',
  },
  // PEND-52 — F3 / Shift+F3 cycle matches in the in-page-find toolbar.
  // The matcher is responsible for actually wiring these (it listens
  // while the toolbar is open); listing them here makes them discoverable
  // in the KeyboardShortcuts help dialog and rebindable in Settings.
  {
    id: 'findInPageNext',
    keys: 'F3',
    category: 'keyboard.category.global',
    description: 'keyboard.findInPageNext',
    condition: 'keyboard.condition.findInPageOpen',
  },
  {
    id: 'findInPagePrev',
    keys: 'Shift + F3',
    category: 'keyboard.category.global',
    description: 'keyboard.findInPagePrev',
    condition: 'keyboard.condition.findInPageOpen',
  },
  {
    id: 'toggleSidebar',
    keys: 'Ctrl + B',
    category: 'keyboard.category.global',
    description: 'keyboard.toggleSidebar',
  },
  {
    id: 'createNewPage',
    keys: 'Ctrl + N',
    category: 'keyboard.category.global',
    description: 'keyboard.createNewPage',
  },
  {
    id: 'showShortcuts',
    keys: '?',
    category: 'keyboard.category.global',
    description: 'keyboard.showKeyboardShortcuts',
  },
  {
    id: 'closeOverlays',
    keys: 'Escape',
    category: 'keyboard.category.global',
    description: 'keyboard.closeOverlays',
  },
  // PEND-67 Phase 8 — re-run the most recently invoked palette command
  // without opening the dialog. Mirrors Raycast's `⌘.` shortcut. When
  // there is no recent command yet the binding falls through to
  // opening the palette in commands mode (see `useAppKeyboardShortcuts`).
  //
  // Same chord as the editor's `collapseExpand` entry, but that one is
  // gated on a focused block (KEY_RULES + the BlockTree document
  // listener); this one is gated on NOT typing in a field, so the two
  // never fire together.
  {
    id: 'runLastCommand',
    keys: 'Ctrl + .',
    category: 'keyboard.category.global',
    description: 'keyboard.runLastCommand',
  },

  // Graph View (BUG-18): zoom controls previously hardcoded in GraphView.tsx
  {
    id: 'graphZoomIn',
    keys: '+ / =',
    category: 'keyboard.category.global',
    description: 'graph.zoomIn',
  },
  {
    id: 'graphZoomOut',
    keys: '-',
    category: 'keyboard.category.global',
    description: 'graph.zoomOut',
  },
  {
    id: 'graphZoomReset',
    keys: '0',
    category: 'keyboard.category.global',
    description: 'graph.zoomReset',
  },

  // Page Editor
  {
    id: 'exportPageMarkdown',
    keys: 'Ctrl + Shift + E',
    category: 'keyboard.category.pageEditor',
    description: 'keyboard.exportPageMarkdown',
    condition: 'keyboard.condition.inPageEditor',
  },

  // Tabs — after FEAT-7 the TabBar is shell-wide on desktop, so the
  // tab-management shortcuts apply everywhere, not just inside the editor.
  // The `desktopOnly` condition matches the runtime `useIsMobile() === false`
  // gate in App.tsx.
  {
    id: 'openInNewTab',
    keys: 'Ctrl + T',
    category: 'keyboard.category.tabs',
    description: 'keyboard.openInNewTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'closeActiveTab',
    keys: 'Ctrl + W',
    category: 'keyboard.category.tabs',
    description: 'keyboard.closeActiveTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'nextTab',
    keys: 'Ctrl + Tab',
    category: 'keyboard.category.tabs',
    description: 'keyboard.nextTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'previousTab',
    keys: 'Ctrl + Shift + Tab',
    category: 'keyboard.category.tabs',
    description: 'keyboard.previousTab',
    condition: 'keyboard.condition.desktopOnly',
  },
  {
    id: 'closeTabOnFocus',
    keys: 'Delete / Backspace',
    category: 'keyboard.category.tabs',
    description: 'keyboard.closeTabOnFocus',
    condition: 'keyboard.condition.tabFocused',
  },

  // Editor Formatting
  {
    id: 'inlineCode',
    keys: 'Ctrl + E',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.inlineCode',
  },
  {
    // #211 P2-11 — rebound from the low-mnemonic `Ctrl+Shift+X` to
    // `Ctrl+Shift+S`. The editor keeps `Ctrl+Shift+X` as a hardcoded legacy
    // alias for one release (see `StrikeWithShortcut` in use-roving-editor).
    id: 'strikethrough',
    keys: 'Ctrl + Shift + S',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.strikethrough',
  },
  {
    id: 'highlight',
    keys: 'Ctrl + Shift + H',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.highlight',
  },
  {
    // #211 P2-5 — underline mark. Ctrl+U is the near-universal underline combo.
    id: 'underline',
    keys: 'Ctrl + U',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.underline',
  },
  {
    id: 'codeBlock',
    keys: 'Ctrl + Shift + C',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.codeBlock',
  },
  {
    id: 'priority1',
    keys: 'Ctrl + Shift + 1',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.priority1',
  },
  {
    id: 'priority2',
    keys: 'Ctrl + Shift + 2',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.priority2',
  },
  {
    id: 'priority3',
    keys: 'Ctrl + Shift + 3',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.priority3',
  },
  {
    id: 'linkPopover',
    keys: 'Ctrl + K',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.linkPopover',
  },
  {
    // Documentation-only: chip-deletion semantics inside the TipTap
    // extension, inseparable from the Backspace key.
    id: 'backspaceChip',
    keys: 'Backspace',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.backspaceChip',
    condition: 'keyboard.condition.afterChip',
    rebindable: false,
  },

  // Spaces (FEAT-3p11) — digit hotkeys for instant space switching.
  // `Ctrl+1`…`Ctrl+9` (`Cmd+1`…`Cmd+9` on macOS — `matchesShortcutBinding`
  // already accepts `metaKey` in place of `ctrlKey`) jump straight to the
  // Nth space in the alphabetical `availableSpaces` order. Out-of-range
  // digits are silent no-ops; the handler short-circuits when typing in
  // an input/textarea/contenteditable so it never steals keystrokes.
  // The `Ctrl + 1`-`Ctrl + 6` collision with `heading1`-`heading6` is
  // benign: the heading handlers (#713, `useBlockTreeKeyboardShortcuts`)
  // only fire while a block is focused — exactly when the space switcher
  // bails out — and the entries live in a different category, so
  // `findConflicts` does not flag them.
  {
    id: 'switchSpace1',
    keys: 'Ctrl + 1',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace1',
  },
  {
    id: 'switchSpace2',
    keys: 'Ctrl + 2',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace2',
  },
  {
    id: 'switchSpace3',
    keys: 'Ctrl + 3',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace3',
  },
  {
    id: 'switchSpace4',
    keys: 'Ctrl + 4',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace4',
  },
  {
    id: 'switchSpace5',
    keys: 'Ctrl + 5',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace5',
  },
  {
    id: 'switchSpace6',
    keys: 'Ctrl + 6',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace6',
  },
  {
    id: 'switchSpace7',
    keys: 'Ctrl + 7',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace7',
  },
  {
    id: 'switchSpace8',
    keys: 'Ctrl + 8',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace8',
  },
  {
    id: 'switchSpace9',
    keys: 'Ctrl + 9',
    category: 'keyboard.category.spaces',
    description: 'keyboard.switchSpace9',
  },

  // Suggestion Popup
  {
    id: 'suggestionClose',
    keys: 'Escape',
    category: 'keyboard.category.suggestionPopup',
    description: 'keyboard.suggestionClose',
    condition: 'keyboard.condition.popupOpen',
  },
  {
    id: 'suggestionPassSpace',
    keys: 'Space',
    category: 'keyboard.category.suggestionPopup',
    description: 'keyboard.suggestionPassSpace',
    condition: 'keyboard.condition.popupOpen',
  },
  {
    id: 'suggestionAutocomplete',
    keys: 'Tab',
    category: 'keyboard.category.suggestionPopup',
    description: 'keyboard.suggestionAutocomplete',
    condition: 'keyboard.condition.popupOpen',
  },
]
