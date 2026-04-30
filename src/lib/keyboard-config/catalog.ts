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
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  // Navigation
  {
    id: 'prevBlock',
    keys: 'Arrow Up / Left',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToPreviousBlock',
    condition: 'keyboard.condition.atStart',
  },
  {
    id: 'nextBlock',
    keys: 'Arrow Down / Right',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToNextBlock',
    condition: 'keyboard.condition.atEnd',
  },

  // Editing
  {
    id: 'saveBlock',
    keys: 'Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.saveBlockAndClose',
  },
  {
    id: 'deleteBlock',
    keys: 'Backspace',
    category: 'keyboard.category.editing',
    description: 'keyboard.deleteBlock',
    condition: 'keyboard.condition.onEmptyBlock',
  },
  {
    id: 'mergeWithPrevious',
    keys: 'Backspace',
    category: 'keyboard.category.editing',
    description: 'keyboard.mergeWithPrevious',
    condition: 'keyboard.condition.atStartOfBlock',
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
    id: 'insertLineBreak',
    keys: 'Shift + Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.insertLineBreak',
    condition: 'keyboard.condition.inEditor',
  },

  // Block Tree
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

  // Pickers
  {
    id: 'tagPicker',
    keys: '@',
    category: 'keyboard.category.pickers',
    description: 'keyboard.tagPicker',
    condition: 'keyboard.condition.inEditor',
  },
  {
    id: 'blockLinkPicker',
    keys: '[[',
    category: 'keyboard.category.pickers',
    description: 'keyboard.blockLinkPicker',
    condition: 'keyboard.condition.inEditor',
  },
  {
    id: 'slashCommand',
    keys: '/',
    category: 'keyboard.category.pickers',
    description: 'keyboard.slashCommandMenu',
    condition: 'keyboard.condition.inEditor',
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
    id: 'toggleBlockSelection',
    keys: 'Ctrl + Click',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.toggleBlockSelection',
  },
  {
    id: 'rangeSelectBlocks',
    keys: 'Shift + Click',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.rangeSelectBlocks',
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

  // Undo/Redo
  {
    id: 'undoLastPageOp',
    keys: 'Ctrl + Z',
    category: 'keyboard.category.undoRedo',
    description: 'keyboard.undoLastPageOp',
    condition: 'keyboard.condition.outsideEditor',
  },
  {
    id: 'redoLastUndoneOp',
    keys: 'Ctrl + Y',
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
    id: 'histRangeSelect',
    keys: 'Shift + Click',
    category: 'keyboard.category.historyView',
    description: 'keyboard.rangeSelect',
  },
  {
    id: 'histRevertSelected',
    keys: 'Enter',
    category: 'keyboard.category.historyView',
    description: 'keyboard.revertSelected',
  },
  {
    id: 'histNavigateItems',
    keys: 'Arrow Up / Arrow Down',
    category: 'keyboard.category.historyView',
    description: 'keyboard.navigateItems',
  },
  {
    id: 'histNavigateVim',
    keys: 'j / k',
    category: 'keyboard.category.historyView',
    description: 'keyboard.navigateItemsVim',
  },

  // Global
  {
    id: 'focusSearch',
    keys: 'Ctrl + F',
    category: 'keyboard.category.global',
    description: 'keyboard.focusSearch',
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
    id: 'gotoConflicts',
    keys: 'Alt + C',
    category: 'keyboard.category.global',
    description: 'keyboard.gotoConflicts',
  },
  {
    id: 'closeOverlays',
    keys: 'Escape',
    category: 'keyboard.category.global',
    description: 'keyboard.closeOverlays',
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
    id: 'strikethrough',
    keys: 'Ctrl + Shift + X',
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
    id: 'backspaceChip',
    keys: 'Backspace',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.backspaceChip',
    condition: 'keyboard.condition.afterChip',
  },

  // Spaces (FEAT-3p11) — digit hotkeys for instant space switching.
  // `Ctrl+1`…`Ctrl+9` (`Cmd+1`…`Cmd+9` on macOS — `matchesShortcutBinding`
  // already accepts `metaKey` in place of `ctrlKey`) jump straight to the
  // Nth space in the alphabetical `availableSpaces` order. Out-of-range
  // digits are silent no-ops; the handler short-circuits when typing in
  // an input/textarea/contenteditable so it never steals keystrokes.
  // The `Ctrl + 1`-`Ctrl + 6` collision with `heading1`-`heading6` is
  // benign: the heading entries are documentation-only (not wired to a
  // global handler) and live in a different category, so `findConflicts`
  // does not flag them.
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
