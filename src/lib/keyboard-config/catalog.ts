/**
 * Static catalog of keyboard shortcuts.
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
  /**
   * `true` marks an entry whose handler is a DOCUMENT/WINDOW-level keydown
   * listener that fires with no specific element focused — even though its
   * category is otherwise focus-scoped (blockTree/blockSelection/
   * listSelection). The matching listener co-fires with the always-on
   * `GLOBAL_LISTENER_CATEGORIES` listeners on the same keystroke, so
   * `findConflicts` must include these entries in its cross-category pass
   * (#1592) — otherwise a rebind onto a chord they already use (notably
   * Escape, shared with `closeOverlays`) goes unflagged. Omit (default) for
   * focus-scoped bindings (e.g. the suggestion-popup keymap, editor chords)
   * that physically cannot collide with a document-level listener.
   */
  documentLevel?: true
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
    // #1592 — dispatched by BlockTree's document-level keydown listener
    // (`useBlockTreeKeyboardShortcuts` `handleZoomOutEscape`); fires with no
    // block focused, so it races the always-on Escape listeners cross-category.
    documentLevel: true,
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
    // #976 (item 15) — open the block-specific history drawer from a focused
    // block, mirroring the `openPropertiesDrawer` discoverability path. The
    // palette's `go-history` opens the GLOBAL history view; this is the
    // per-block drawer. `Ctrl + Shift + H` is taken by `highlight`, so this
    // uses the free `Ctrl + Shift + Y` chord.
    id: 'openBlockHistory',
    keys: 'Ctrl + Shift + Y',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.openBlockHistory',
  },
  {
    // #976 (item 13) — duplicate the focused block + its subtree from the
    // keyboard, mirroring the context-menu "Duplicate" row and the
    // `/duplicate` slash command. The natural `Ctrl + Shift + D` mnemonic is
    // already taken by `openDatePicker`, and `Ctrl + D` is the browser
    // bookmark chord, so this uses the free `Ctrl + Shift + J` chord (no other
    // catalog entry binds it — verified against the full key list).
    id: 'duplicateBlock',
    keys: 'Ctrl + Shift + J',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.duplicateBlock',
  },
  {
    // #976 (item 14) — open the "Turn into" type picker for the focused block
    // from the keyboard, surfacing the same conversion family the context-menu
    // submenu and the `/turn` slash command expose. `Alt + T` (goToToday) and
    // `Ctrl + T` (openInNewTab) are taken; this uses the free `Ctrl + Shift + T`
    // chord (verified against the full key list — only `Ctrl + Shift + Tab`,
    // a distinct key, exists).
    id: 'turnIntoBlock',
    keys: 'Ctrl + Shift + T',
    category: 'keyboard.category.blockTree',
    description: 'keyboard.turnIntoBlock',
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
    // #1733 — keyboard parity with the list views' Space-to-toggle. Adds/removes
    // the anchor block (the last selected, the same block Shift+Arrow extends
    // from) to/from the selection without the mouse. Routed through
    // `matchesShortcutBinding` in `useBlockTreeKeyboardShortcuts` so it's
    // genuinely rebindable (drift test pins this). Default Ctrl+Space avoids the
    // bare-Space collision with text input / scroll.
    id: 'toggleBlockSelectionKbd',
    keys: 'Ctrl + Space',
    category: 'keyboard.category.blockSelection',
    description: 'keyboard.toggleBlockSelectionKbd',
    condition: 'keyboard.condition.withSelection',
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
    // #1592 — `useBlockTreeKeyboardShortcuts` installs a document-level keydown
    // that fires only when NO block is focused (`!focusedBlockId`); it sees the
    // same Escape as the always-on listeners, so include it cross-category.
    documentLevel: true,
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
    // #1592 — list views (`useTrashListShortcuts`/`useListMultiSelect`) install
    // a document-level keydown that fires whenever a selection exists and focus
    // isn't in an input; it co-fires with the always-on Escape listeners.
    documentLevel: true,
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
  // Ctrl+F reclaims the universal in-page-find binding;
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
  // Cmd/Ctrl+K opens the quick-navigation palette. Distinct
  // from `focusSearch` (the find-in-files view) and `findInPage` (the
  // in-page find toolbar) — the three keyboard surfaces map 1:1 to the
  // three search surfaces.
  {
    id: 'paletteOpen',
    keys: 'Ctrl + K',
    category: 'keyboard.category.global',
    description: 'keyboard.paletteOpen',
  },
  // F3 / Shift+F3 cycle matches in the in-page-find toolbar.
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
    // #1576 — the window-level handler (`use-sidebar-keyboard.ts`) bails out
    // while the user is editing in an input/textarea/contenteditable, exactly
    // because TipTap maps Ctrl+B to Bold. Modelling that guard as the
    // `outsideEditor` condition makes it disjoint from the editor-scoped `bold`
    // entry (condition `inEditor`), so `findConflicts` does NOT flag the default
    // Ctrl+B pair (they never co-fire) while still flagging a wildcard global
    // action rebound onto Ctrl+B.
    condition: 'keyboard.condition.outsideEditor',
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
    // #1592 — model the runtime guard explicitly. The window-level handler
    // (`useAppKeyboardShortcuts` `handleCloseOverlays`) only acts when an
    // overlay/editing surface is open and bails while typing in a field. That
    // precondition is disjoint from the other document-level Escape listeners
    // (`whenZoomed`/`withSelection`/`hasSelection`), so the default layered
    // Escape chain is correctly NOT flagged, while a rebind onto a chord a
    // wildcard always-on listener uses still surfaces.
    condition: 'keyboard.condition.whenOverlayOpen',
  },
  // Phase 8 — re-run the most recently invoked palette command
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

  // Graph View: zoom controls previously hardcoded in GraphView.tsx
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

  // Tabs — after the TabBar is shell-wide on desktop, so the
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
  // #1576 — Bold (Ctrl+B) and Italic (Ctrl+I) are TipTap StarterKit defaults
  // (the `Bold`/`Italic` extensions in `use-roving-editor.ts`). Their keymaps
  // live inside the ProseMirror extensions, NOT routed through
  // `matchesShortcutBinding`/`getShortcutKeys`, so they are documentation-only
  // (`rebindable: false`) like `insertLineBreak`. Before this entry existed
  // they were invisible to `findConflicts`, so Settings advertised Ctrl+B /
  // Ctrl+I as "free" even though TipTap already owns them. They are flagged
  // `documentLevel` so the cross-category pass (#1592) reserves the chord
  // against an always-on listener rebound onto it (e.g. a global wildcard
  // dropped onto Ctrl+B): the editor keymap fires on the bubbling keydown the
  // window-level listeners also see. `toggleSidebar` itself carries the
  // disjoint `outsideEditor` condition (its handler bails while editing — see
  // `use-sidebar-keyboard.ts`), so the default Ctrl+B pair stays unflagged.
  {
    id: 'bold',
    keys: 'Ctrl + B',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.bold',
    condition: 'keyboard.condition.inEditor',
    rebindable: false,
    documentLevel: true,
  },
  {
    id: 'italic',
    keys: 'Ctrl + I',
    category: 'keyboard.category.editorFormatting',
    description: 'keyboard.italic',
    condition: 'keyboard.condition.inEditor',
    rebindable: false,
    documentLevel: true,
  },
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

  // Spaces — digit hotkeys for instant space switching.
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
