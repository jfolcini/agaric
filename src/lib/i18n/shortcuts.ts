/**
 * i18n namespace: shortcuts
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const shortcuts: Record<string, string> = {
  // Translators: Keyboard shortcuts help sheet (side panel opened with the "?" key): footer
  // button that opens Settings › Keyboard, and the subtitle under the sheet title.
  'keyboard.customizeButton': 'Customize in Settings',
  'keyboard.sheetDescription': 'Available keyboard shortcuts and syntax reference for the editor.',

  // Translators: Search box at the top of the help sheet: placeholder, screen-reader label
  // (aria-label), and the message shown when no shortcut matches the typed text.
  'keyboard.filterPlaceholder': 'Search shortcuts…',
  'keyboard.filterLabel': 'Filter shortcuts',
  'keyboard.filterEmpty': 'No shortcuts match your filter',

  // Translators: Column headers of the help sheet tables: the key-combination column, the
  // column saying what it does, and the right-hand column of the Markdown syntax table.
  'keyboard.shortcutHeader': 'Shortcut',
  'keyboard.actionHeader': 'Action',
  'keyboard.descriptionHeader': 'Description',

  // Translators: "Essential" table at the top of the help sheet, a quick-start list for new
  // users: its heading, then what each basic key does (undo, typing "/", "[[", "@", search).
  // #214 Phase 3 — "Essential" group surfaced at the top of the help
  // sheet so new users discover the five core triggers (undo, slash,
  // link, tag, search) before the long per-category list.
  'keyboard.category.essential': 'Essential',
  'keyboard.essential.undo': 'Undo your last change',
  'keyboard.essential.slash': 'Open the command menu',
  'keyboard.essential.link': 'Link to another page',
  'keyboard.essential.tag': 'Tag a block',
  'keyboard.essential.search': 'Search your notes',

  // Translators: Section headings of the shortcut list, in the help sheet and Settings › Keyboard.
  // "Block tree" = actions on blocks of the outline; "Pickers" = pop-up lists opened by typing
  // a trigger such as @ or [[; "Journal" = the dated journal view; "List selection" = picking
  // several rows of a list; "History view" = the list of past edits; "Global" = works anywhere.
  'keyboard.category.navigation': 'Navigation',
  'keyboard.category.editing': 'Editing',
  'keyboard.category.blockTree': 'Block tree',
  'keyboard.category.pickers': 'Pickers',
  'keyboard.category.journal': 'Journal',
  'keyboard.category.blockSelection': 'Block selection',
  'keyboard.category.undoRedo': 'Undo / redo',
  'keyboard.category.listSelection': 'List selection',
  'keyboard.category.historyView': 'History view',
  'keyboard.category.global': 'Global',

  // Translators: Conditions shown after a shortcut: beside the keys in the help sheet, and in
  // parentheses after the action in Settings › Keyboard. They say when the shortcut applies;
  // most are lowercase fragments, so keep the capitalization style of the English.
  // atStart / atEnd belong to the keys "Arrow Up / Arrow Left" and "Arrow Down / Arrow Right":
  // each half says where in the block that arrow works.
  'keyboard.condition.atStart': 'Up on the first line, Left at the start',
  'keyboard.condition.atEnd': 'Down on the last line, Right at the end',
  'keyboard.condition.onEmptyBlock': 'on empty block',
  'keyboard.condition.atStartOfBlock': 'at start of block',
  'keyboard.condition.inEditor': 'in editor',
  'keyboard.condition.inTable': 'in a table',
  'keyboard.condition.notEditing': 'not editing',
  'keyboard.condition.notEditingOrAtBlockEdge':
    'not editing, or with the text selection at the block edge',
  // Translators: "selection cursor" = the highlight moved over blocks with Ctrl+Arrow while no
  // block is being edited.
  'keyboard.condition.onCursorBlock': 'on the block under the selection cursor',
  'keyboard.condition.withSelection': 'with selection',
  'keyboard.condition.outsideEditor': 'outside editor',
  'keyboard.condition.listItemFocused': 'When a list item is focused',
  'keyboard.condition.hasSelection': 'When items are selected',

  // Translators: Navigation section: action labels (what the keys do), in the help sheet and
  // Settings › Keyboard. atLink is a condition: when the text cursor is on a link.
  'keyboard.moveToPreviousBlock': 'Move to previous block',
  'keyboard.moveToNextBlock': 'Move to next block',
  'keyboard.followLink': 'Follow the link',
  'keyboard.condition.atLink': 'At a page link or block reference',

  // Translators: Editing section: action labels for keys used while typing in a block. "Indent" /
  // "Dedent" move the block one level right / left in the outline; "children" are the blocks
  // nested under it. TODO, DOING, DONE and CANCELLED are task-state keywords; keep them.
  'keyboard.saveBlockAndClose': 'Save block and add a new block below',
  'keyboard.leaveBlockAndSelect': 'Save block, close editor and select the block',
  'keyboard.deleteBlock': 'Delete block',
  'keyboard.mergeWithPrevious': 'Merge with previous',
  'keyboard.indentBlock': 'Indent block',
  'keyboard.dedentBlock': 'Dedent block',
  'keyboard.cycleTaskState': 'Cycle task state (TODO → DOING → DONE → CANCELLED → none)',
  'keyboard.collapseExpandChildren': 'Collapse / expand children',
  'keyboard.insertOrEditLink': 'Insert or edit external link',
  'keyboard.toggleCodeBlock': 'Toggle code block',
  'keyboard.toggleStrikethrough': 'Toggle strikethrough',
  'keyboard.toggleHighlight': 'Toggle highlight',
  'keyboard.moveBlockUp': 'Move block up',
  'keyboard.moveTableRowUp': 'Move table row up',
  'keyboard.moveTableRowDown': 'Move table row down',
  'keyboard.moveTableColumnLeft': 'Move table column left',
  'keyboard.moveTableColumnRight': 'Move table column right',
  'keyboard.moveBlockDown': 'Move block down',
  'keyboard.insertLineBreak': 'Insert line break (soft return)',

  // Translators: Block tree section: actions on the block being edited. "Heading 1" to "Heading
  // 6" turn it into a heading of that level; "subtree" = the block and the blocks nested under it.
  'keyboard.openDatePicker': 'Open date picker',
  'keyboard.openPropertiesDrawer': 'Open block properties drawer',
  'keyboard.openBlockHistory': 'Open block history',
  'keyboard.duplicateBlock': 'Duplicate block (and its subtree)',
  'keyboard.turnIntoBlock': 'Turn block into another type',
  'keyboard.heading1': 'Heading 1',
  'keyboard.heading2': 'Heading 2',
  'keyboard.heading3': 'Heading 3',
  'keyboard.heading4': 'Heading 4',
  'keyboard.heading5': 'Heading 5',
  'keyboard.heading6': 'Heading 6',

  // Translators: Pickers section: pop-up lists that open when you type @, [[, (( or / in a block.
  // "Block link picker" links to a page; "Block reference picker" points at a single block.
  'keyboard.tagPicker': 'Tag picker',
  'keyboard.blockLinkPicker': 'Block link picker',
  'keyboard.blockRefPicker': 'Block reference picker',
  'keyboard.slashCommandMenu': 'Slash command menu',

  // Translators: Journal section (the dated journal view): step back / forward by the period on
  // screen (a day, week or month), jump to today, and add a first block to an empty daily
  // page. emptyDaily is a condition: when that day's journal page has no blocks yet.
  'keyboard.previousDayWeekMonth': 'Previous day / week / month',
  'keyboard.nextDayWeekMonth': 'Next day / week / month',
  'keyboard.goToToday': 'Go to today',
  'keyboard.createJournalBlock': 'Create block in daily journal',
  'keyboard.condition.emptyDaily': 'When daily page is empty',

  // Translators: Block selection section: selecting several blocks at once, while none is being
  // edited. "Range select" = select every block between two clicks; "markdown outline" =
  // plain text with one "- " bullet line per block.
  'keyboard.toggleBlockSelection': 'Toggle block selection',
  'keyboard.rangeSelectBlocks': 'Range select blocks',
  'keyboard.extendSelectionDown': 'Extend block selection down',
  'keyboard.extendSelectionUp': 'Extend block selection up',
  'keyboard.blockCursorDown': 'Move to the next block without changing the selection',
  'keyboard.blockCursorUp': 'Move to the previous block without changing the selection',
  'keyboard.editCursorBlock': 'Edit the block, the caret at its end',
  'keyboard.toggleBlockSelectionKbd':
    'Toggle current block in selection (selects the block you are editing)',
  'keyboard.selectAllBlocks': 'Select all blocks',
  'keyboard.clearSelection': 'Clear selection',
  'keyboard.copyBlocks': 'Copy selected blocks (as markdown outline)',
  'keyboard.cutBlocks': 'Cut selected blocks (as markdown outline)',
  'keyboard.pasteBlocks': 'Paste blocks (from markdown outline)',

  // Translators: Undo / redo section: undo and redo of changes to a page's blocks (moves,
  // deletions, edits) made outside the text editor.
  'keyboard.undoLastPageOp': 'Undo last page operation',
  'keyboard.redoLastUndoneOp': 'Redo last undone operation',

  // Translators: List selection section: selecting rows in lists such as Pages, Trash or History
  // (checkbox-style selection, not text selection).
  'keyboard.listToggleSelection': 'Toggle item selection',
  'keyboard.listSelectAll': 'Select all items',
  'keyboard.listClearSelection': 'Clear selection',

  // Translators: History view section (the list of past edits): select rows, revert (undo) the
  // selected edits, move between rows; "vim-style" = the j / k keys of the Vim text editor.
  'keyboard.toggleSelection': 'Toggle selection',
  'keyboard.rangeSelect': 'Range select',
  'keyboard.selectAll': 'Select all',
  'keyboard.revertSelected': 'Revert selected',
  'keyboard.navigateItems': 'Navigate items',
  'keyboard.navigateItemsVim': 'Navigate items (vim-style)',

  // Translators: Global section: shortcuts that work anywhere in the app. The "quick search
  // palette" and "command palette" are pop-up search boxes for jumping to pages and running
  // commands; the "quick switcher" jumps to a page by name. findInPageOpen is a condition: when
  // the find bar of the current page is open. The sidebar is the left navigation panel.
  'keyboard.focusSearch': 'Search across all pages',
  'keyboard.findInPage': 'Find in current page',
  'keyboard.replaceInPage': 'Find and replace in current page',
  'keyboard.paletteOpen': 'Open quick search palette',
  'keyboard.quickSwitcher': 'Open the quick switcher (search pages)',
  'keyboard.commandPalette': 'Open the command palette',
  'keyboard.navigateBack': 'Go back',
  'keyboard.navigateForward': 'Go forward',
  'keyboard.findInPageNext': 'Next match in page',
  'keyboard.findInPagePrev': 'Previous match in page',
  'keyboard.condition.findInPageOpen': 'When the find toolbar is open',
  'keyboard.toggleSidebar': 'Toggle sidebar',
  'keyboard.createNewPage': 'Create new page',
  'keyboard.showKeyboardShortcuts': 'Show keyboard shortcuts',

  // Translators: Page editor section, while a page is open: save it as a Markdown file, show it
  // in the Graph view (map of linked pages), and switch its edit mode: "as blocks" (one block
  // at a time) or "as one page" (the whole page as a single document).
  'keyboard.exportPageMarkdown': 'Export page as Markdown',
  'keyboard.showPageInGraph': 'Show this page in graph',
  'keyboard.togglePageMode': 'Edit this page as blocks or as one page',

  // Translators: Global section, continued. "Overlays" = open dialogs, menus and pop-ups;
  // whenOverlayOpen is its condition. A "palette command" is one run from the command palette.
  // "Zoom the interface" makes the whole app larger or smaller (not the zoom into a block).
  'keyboard.closeOverlays': 'Close overlays, cancel editing, clear selection',
  'keyboard.condition.whenOverlayOpen': 'When an overlay or editing surface is open',
  'keyboard.runLastCommand': 'Re-run last palette command',
  'keyboard.interfaceZoomIn': 'Zoom the interface in',
  'keyboard.interfaceZoomOut': 'Zoom the interface out',
  'keyboard.interfaceZoomReset': 'Reset the interface zoom',

  // Translators: Page editor section heading and its conditions: when a page is open; while in
  // "Edit as Markdown", the mode that shows the page as raw Markdown text (use the same name
  // as the page menu item).
  'keyboard.category.pageEditor': 'Page editor',
  'keyboard.condition.inPageEditor': 'When viewing a page',
  'keyboard.savePageSource': 'Save the Markdown in Edit as Markdown',
  'keyboard.condition.inPageSource': 'In Edit as Markdown',

  // Translators: Block tree section: "zoom in" shows only the focused block and the blocks nested
  // under it, as if it were the page; "zoom out" returns to the whole page. Not a visual zoom.
  // Each condition key says when the action above it applies.
  'keyboard.zoomIn': 'Zoom in to focused block',
  'keyboard.condition.onFocusedParentBlock': 'When a block with children is focused',
  'keyboard.zoomOut': 'Zoom out to page root',
  'keyboard.condition.whenZoomed': 'When zoomed into a block',

  // Translators: Markdown syntax table of the help sheet: what each piece of typed text produces
  // (the left column shows what to type, e.g. **text** for Bold). TODO and DONE are task-state
  // keywords; keep them.
  'keyboard.syntax.bold': 'Bold',
  'keyboard.syntax.italic': 'Italic',
  'keyboard.syntax.inlineCode': 'Inline code',
  'keyboard.syntax.strikethrough': 'Strikethrough',
  'keyboard.syntax.highlight': 'Highlight',
  'keyboard.syntax.heading': 'Heading (1-6 levels)',
  'keyboard.syntax.blockquote': 'Blockquote',
  'keyboard.syntax.codeBlock': 'Code block',
  'keyboard.syntax.todoCheckbox': 'TODO checkbox',
  'keyboard.syntax.doneCheckbox': 'DONE checkbox',
  'keyboard.syntax.tagReference': 'Tag reference',
  'keyboard.syntax.pageLink': 'Page link',
  'keyboard.syntax.blockReference': 'Block reference',
  'keyboard.syntax.slashCommand': 'Slash command menu',
  // #214 Phase 3 — previously undocumented inline-syntax triggers.
  'keyboard.syntax.emoji': 'Emoji picker',
  'keyboard.syntax.properties': 'Block properties',
  'keyboard.syntax.underline': 'Underline',

  // Translators: Settings › Keyboard tab: intro text at the top, and the pencil button on each row
  // (tooltip and screen-reader label); {{action}} = an action label from this file,
  // e.g. "Toggle bold".
  'keyboard.settings.description':
    'Customize keyboard shortcuts. Click the edit button to change a binding.',
  'keyboard.settings.editShortcutFor': 'Edit shortcut for {{action}}',

  // Translators: Save / Cancel of the inline key-combination editor: icon-button tooltips and
  // labels in Settings › Keyboard, and text buttons in its Quick capture row.
  'keyboard.settings.saveButton': 'Save',
  'keyboard.settings.cancelButton': 'Cancel',

  // Translators: Reset controls: a small button on a customized row and its screen-reader label
  // ({{action}} = an action label like "Toggle bold"); the button under the list, which is also
  // the confirm button of the dialog whose body and title follow.
  'keyboard.settings.resetButton': 'Reset to default',
  'keyboard.settings.resetShortcutFor': 'Reset {{action}} to default',
  'keyboard.settings.resetAllButton': 'Reset all to defaults',
  'keyboard.settings.resetAllConfirm': 'Reset all keyboard shortcuts to their default bindings?',
  'keyboard.settings.resetAllTitle': 'Reset all shortcuts?',

  // Translators: Warning under a row whose keys another action also uses; {{shortcuts}} = a
  // comma-separated list of action labels. "Customized" = very short badge on a changed binding
  // (also in the help sheet).
  'keyboard.settings.conflictWarning': 'Conflicts with: {{shortcuts}}',
  'keyboard.settings.customized': 'Customized',

  // Translators: Inline key-combination editor: input placeholder, format hint and error messages.
  // Key names (Ctrl, Shift, E, F1-F24, Escape, Enter, Tab, Page Up, Arrow Up…) are what the user
  // types, so keep them in English. "Modifier" keys are Ctrl, Shift, Alt and Cmd.
  'keyboard.settings.typeNewBinding': 'Type new key binding...',
  'keyboard.settings.formatHint': 'Format: Ctrl + Shift + E',
  'keyboard.settings.emptyBinding': 'Key binding cannot be empty',
  'keyboard.settings.validationModifierOnly': 'Binding must include at least one non-modifier key',
  'keyboard.settings.validationUnknownKey':
    'Unrecognized key name. Use a single character, F1-F24, or a key name like Escape, Enter, Tab, Backspace, Delete, Home, End, Page Up, Page Down, Space, or Arrow Up',

  // Translators: Tabs section: the page tabs in the TabBar (strip of open pages above the view),
  // not the Tab key. tabFocused and desktopOnly are conditions: when a tab has keyboard focus;
  // only on computers, not phones.
  'keyboard.category.tabs': 'Tabs',
  'keyboard.openInNewTab': 'Open current page in new tab',
  'keyboard.closeActiveTab': 'Close active tab',
  'keyboard.nextTab': 'Switch to next tab',
  'keyboard.previousTab': 'Switch to previous tab',
  'keyboard.reopenClosedTab': 'Reopen the last closed tab',
  'keyboard.selectTab1': 'Switch to tab 1',
  'keyboard.selectTab2': 'Switch to tab 2',
  'keyboard.selectTab3': 'Switch to tab 3',
  'keyboard.selectTab4': 'Switch to tab 4',
  'keyboard.selectTab5': 'Switch to tab 5',
  'keyboard.selectTab6': 'Switch to tab 6',
  'keyboard.selectTab7': 'Switch to tab 7',
  'keyboard.selectTab8': 'Switch to tab 8',
  'keyboard.selectLastTab': 'Switch to the last tab',
  'keyboard.closeTabOnFocus': 'Close focused tab',
  'keyboard.condition.tabFocused': 'When a tab is focused',
  'keyboard.condition.desktopOnly': 'Desktop only',

  // Translators: Editor formatting section: text formatting while typing in a block. Priority
  // 1-3 = task priority; a "chip" is the inline pill for a page link, tag or block reference,
  // and "re-expand" turns it back into editable text. afterChip is a condition.
  'keyboard.category.editorFormatting': 'Editor formatting',
  'keyboard.bold': 'Toggle bold',
  'keyboard.italic': 'Toggle italic',
  'keyboard.inlineCode': 'Toggle inline code',
  'keyboard.strikethrough': 'Toggle strikethrough',
  'keyboard.highlight': 'Toggle highlight',
  'keyboard.underline': 'Toggle underline',
  'keyboard.codeBlock': 'Toggle code block',
  'keyboard.priority1': 'Set priority 1 (high)',
  'keyboard.priority2': 'Set priority 2 (medium)',
  'keyboard.priority3': 'Set priority 3 (low)',
  'keyboard.linkPopover': 'Insert/edit link',
  'keyboard.backspaceChip': 'Re-expand chip for editing',
  'keyboard.condition.afterChip': 'When cursor is after a chip',

  // Translators: Suggestion popup section (SuggestionList: the pop-up list shown while typing
  // after @, [[ or /): close it, type a space into its search text without closing it, or fill
  // in the highlighted item. popupOpen is the condition.
  'keyboard.category.suggestionPopup': 'Suggestion popup',
  'keyboard.suggestionClose': 'Close popup',
  'keyboard.suggestionPassSpace': 'Insert space in query',
  'keyboard.suggestionAutocomplete': 'Autocomplete selection',
  'keyboard.condition.popupOpen': 'When suggestion popup is open',

  // Translators: Spaces section. A space is a separate workspace such as Work or Personal (not a
  // blank character); the number is the space's position in the Sidebar's space list.
  'keyboard.category.spaces': 'Spaces',
  'keyboard.switchSpace1': 'Switch to space 1',
  'keyboard.switchSpace2': 'Switch to space 2',
  'keyboard.switchSpace3': 'Switch to space 3',
  'keyboard.switchSpace4': 'Switch to space 4',
  'keyboard.switchSpace5': 'Switch to space 5',
  'keyboard.switchSpace6': 'Switch to space 6',
  'keyboard.switchSpace7': 'Switch to space 7',
  'keyboard.switchSpace8': 'Switch to space 8',
  'keyboard.switchSpace9': 'Switch to space 9',

  // Translators: Quick capture section of the help sheet: a small window for jotting a note,
  // opened by a key combination that works system-wide (from any app, even in the background).
  // Quick capture — announced in the help panel so the global
  // hotkey is discoverable. The actual binding is sourced at runtime
  // from `loadQuickCaptureShortcut()` (platform-specific default, user
  // overridable in Settings → Keyboard).
  'keyboard.category.quickCapture': 'Quick capture',
  'keyboard.quickCapture.openDialog': 'Open quick capture (system-wide)',

  // Translators: Deep links table at the bottom of the help sheet (agaric:// addresses that open
  // the app): heading, intro, column headers ("Opens" = what the link opens), row descriptions.
  // ULID = the unique ID code of a page or block. "keyboard, sync" are literal words typed in
  // the address; keep them. "Appearance" is the Settings tab of that name.
  // Deep links — `agaric://…` URLs the OS routes back into the app.
  // Listed in the help sheet so power users discover the scheme.
  'keyboard.section.deepLinks': 'Deep links',
  'keyboard.deepLinks.description':
    'Open Agaric from anywhere — paste these URLs into your browser, terminal, or any link surface.',
  'keyboard.deepLinks.pathHeader': 'URL',
  'keyboard.deepLinks.actionHeader': 'Opens',
  'keyboard.deepLinks.block': 'Jump to a specific block by ULID',
  'keyboard.deepLinks.page': 'Jump to a specific page by ULID',
  'keyboard.deepLinks.settings': 'Open a Settings tab (e.g. keyboard, sync)',
  'keyboard.deepLinks.safeMode': 'Turn custom CSS off and open Appearance',
}
