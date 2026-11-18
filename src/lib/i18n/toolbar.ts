/**
 * i18n namespace: toolbar
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const toolbar: Record<string, string> = {
  // Translators: Text-style buttons of the SelectionBubbleMenu (the small bar that pops up over
  // selected text) and of the Format menu in the FormattingToolbar (the bar of editing buttons
  // shown while a block is edited): screen-reader label and menu-row text. "Highlight" = a
  // coloured marker behind the text; "Inline code" = monospace code inside a line of text.
  'toolbar.bold': 'Bold',
  'toolbar.italic': 'Italic',
  'toolbar.code': 'Inline code',
  'toolbar.strikethrough': 'Strikethrough',
  'toolbar.highlight': 'Highlight',
  'toolbar.underline': 'Underline',

  // Translators: Link button of the SelectionBubbleMenu (label and tooltip): a link to a web
  // address, as opposed to a "Page link" to another page of your notes.
  'toolbar.link': 'External link',

  // Translators: FormattingToolbar buttons: screen-reader label, and the row text when a narrow
  // window moves the button into the "More" menu. "Tag" = a label attached to a block (noun).
  'toolbar.pageLink': 'Page link',
  'toolbar.tag': 'Tag',
  'toolbar.emoji': 'Emoji',
  'toolbar.codeBlock': 'Code block',
  'toolbar.insertDate': 'Insert date',
  'toolbar.dueDate': 'Due date',
  // Translators: TODO is the task-state keyword, written in English in notes; keep it as is.
  'toolbar.todoToggle': 'Toggle TODO state',
  'toolbar.heading': 'Heading',

  // Translators: Cancel button of the toolbar in "Edit as Markdown" mode: throws away the edits
  // made to the page's Markdown text.
  'toolbar.discard': 'Discard changes',

  // Translators: Screen-reader names of the two editing toolbars: the FormattingToolbar (shown
  // while a block is edited) and the SelectionBubbleMenu (pops up over selected text).
  'toolbar.formatting': 'Formatting',
  'toolbar.selectionFormatting': 'Selection formatting',

  // Translators: Two FormattingToolbar buttons that open menus, with their tooltips: "Format"
  // (text styles: bold, italic …) and "Turn into" (change the block's type: heading, list,
  // quote, code block …). Short button text.
  'toolbar.format': 'Format',
  'toolbar.formatTip': 'Text formatting',
  'toolbar.turnInto': 'Turn into',
  'toolbar.turnIntoTip': 'Turn into (block type)',

  // Translators: FormattingToolbar buttons: screen-reader label, and the row text when a narrow
  // window moves the button into the "More" menu.
  'toolbar.bulletList': 'Bullet list',
  // Translators: "Internal link" = a link to another page of your notes; "Block reference" = a
  // link to a single block (one bullet); "Insert query" = embed a live list of search results.
  'toolbar.internalLink': 'Internal link',
  'toolbar.insertBlockRef': 'Block reference',
  'toolbar.insertQuery': 'Insert query',
  'toolbar.insertTag': 'Insert tag',
  'toolbar.headingLevel': 'Heading level',
  // Translators: Task priority levels; 1 is the most urgent.
  'toolbar.priority1': 'Priority 1 (high)',
  'toolbar.priority2': 'Priority 2 (medium)',
  'toolbar.priority3': 'Priority 3 (low)',
  // Translators: Each click moves the task to the next priority level (verb, button).
  'toolbar.cyclePriority': 'Cycle priority',
  // Translators: "Due" = the deadline; "Scheduled" = the day you plan to start the task.
  'toolbar.setDueDate': 'Set due date',
  'toolbar.setScheduledDate': 'Set scheduled date',
  'toolbar.undo': 'Undo',
  'toolbar.redo': 'Redo',
  'toolbar.paragraph': 'Paragraph',

  // Translators: Tooltips of the editing-toolbar buttons. The part in parentheses is the keyboard
  // shortcut or the characters you type for the same action ("[[", "((", "{{", "@", "/due" …):
  // keep it exactly as written. "Blockquote" and "Properties" alone are button labels.
  'toolbar.boldTip': 'Bold (Ctrl+B)',
  'toolbar.italicTip': 'Italic (Ctrl+I)',
  'toolbar.codeTip': 'Inline code',
  'toolbar.strikethroughTip': 'Strikethrough',
  'toolbar.highlightTip': 'Highlight',
  'toolbar.underlineTip': 'Underline (Ctrl+U)',
  'toolbar.pageLinkTip': 'Page link ([[)',
  'toolbar.blockRefTip': 'Block reference (())',
  'toolbar.queryTip': 'Embed a query ({{)',
  'toolbar.tagTip': 'Tag (@)',
  'toolbar.emojiTip': 'Insert emoji (:shortcode:)',
  'toolbar.blockquote': 'Blockquote',
  'toolbar.priority1Tip': 'Priority 1 — high (Ctrl+Shift+1)',
  'toolbar.priority2Tip': 'Priority 2 — medium (Ctrl+Shift+2)',
  'toolbar.priority3Tip': 'Priority 3 — low (Ctrl+Shift+3)',
  'toolbar.cyclePriorityTip': 'Cycle priority (Ctrl+Shift+1)',
  'toolbar.insertDateTip': 'Insert date (Ctrl+Shift+D)',
  'toolbar.dueDateTip': 'Due date (/due)',
  'toolbar.scheduledDateTip': 'Scheduled date (/schedule)',
  // Translators: TODO is the task-state keyword, written in English in notes; keep it as is.
  'toolbar.todoToggleTip': 'TODO cycle (Ctrl+Enter)',
  // Translators: Opens the BlockPropertyDrawer, a side panel of the block's fields (due date,
  // assignee …).
  'toolbar.properties': 'Properties',
  'toolbar.propertiesTip': 'Block properties (Ctrl+Shift+P)',
  'toolbar.undoTip': 'Undo (Ctrl+Z)',
  'toolbar.redoTip': 'Redo (Ctrl+Y)',
  // Translators: Tooltip of the Cancel button in "Edit as Markdown" mode.
  'toolbar.discardTip': 'Discard changes',

  // Translators: Block types in the "Turn into" menu of the FormattingToolbar (menu rows, with
  // tooltips that show the Markdown you can type instead; keep that part as written).
  // "Divider" = a horizontal line; "Callout" = a coloured box with an icon (Info, Warning …).
  'toolbar.orderedList': 'Ordered list',
  'toolbar.divider': 'Divider',
  'toolbar.dividerTip': 'Divider (---)',
  'toolbar.callout': 'Callout',

  // Translators: Language picker of a code block (in the "Turn into" menu and on the code block
  // itself): its label, the "no syntax colouring" choice, and the row shown when the typed name
  // matches no known language; {{language}} = what the user typed, e.g. "elixir".
  'toolbar.codeBlockLanguage': 'Code block language',
  'toolbar.plainText': 'Plain text',
  'toolbar.noLanguageMatch': 'No languages match',
  'toolbar.useCustomLanguage': 'Use "{{language}}"',

  // Translators: FormattingToolbar button that opens the menu of buttons that did not fit
  // (screen-reader label and tooltip). "More" must be short.
  'toolbar.more': 'More',
  'toolbar.moreTip': 'More toolbar actions',

  // Translators: "Table" button of the FormattingToolbar, shown only while the cursor is in a
  // table, with its tooltip and the menu it opens (rows, columns, delete the table).
  // #215 — table row/column operations. The trigger only appears when the
  // selection is inside a table cell.
  'toolbar.tableOps': 'Table',
  'toolbar.tableOpsTip': 'Table row & column actions',
  'toolbar.tableInsertRowAbove': 'Insert row above',
  'toolbar.tableInsertRowBelow': 'Insert row below',
  'toolbar.tableInsertColumnLeft': 'Insert column left',
  'toolbar.tableInsertColumnRight': 'Insert column right',
  'toolbar.tableDeleteRow': 'Delete row',
  'toolbar.tableDeleteColumn': 'Delete column',
  'toolbar.tableDeleteTable': 'Delete table',

  // Translators: Small grip handles at the start of a table row and on top of a table column:
  // their screen-reader labels, tooltips and menu items, plus the "+" buttons at the table's end.
  // #6607 — the table's own handles, and the moves and sorts they share with the menu.
  'toolbar.tableRowActions': 'Row actions',
  'toolbar.tableColumnActions': 'Column actions',
  'toolbar.tableRowHandleTip': 'Row actions; drag to move the row',
  'toolbar.tableColumnHandleTip': 'Column actions; drag to move the column',
  'toolbar.tableAddRow': 'Add row',
  'toolbar.tableAddColumn': 'Add column',
  'toolbar.tableMoveRowUp': 'Move row up',
  'toolbar.tableMoveRowDown': 'Move row down',
  'toolbar.tableMoveColumnLeft': 'Move column left',
  'toolbar.tableMoveColumnRight': 'Move column right',
  'toolbar.tableSortAscending': 'Sort ascending',
  'toolbar.tableSortDescending': 'Sort descending',

  // Translators: FormattingToolbar button that opens a grid for picking a new table's size.
  // "Drag to size" is the caption under the grid until a size is hovered (then it shows
  // "3 × 4"); {{rows}}/{{cols}} = number of rows/columns, the screen-reader label of each cell.
  // #215b — the toolbar table insert grid-picker.
  'toolbar.insertTable': 'Insert table',
  'toolbar.insertTableTip': 'Insert table (/table)',
  'toolbar.tableInsertHint': 'Drag to size',
  'toolbar.tableDimensionsCell': '{{rows}} by {{cols}} table',

  // Translators: FormattingToolbar button that starts a new line inside the same block (for
  // phone keyboards, which have no Shift+Enter); label and tooltip.
  // #5160 D2 — a line break inside the block (Shift+Enter, for virtual keyboards).
  'toolbar.newLine': 'New line',
  'toolbar.newLineTip': 'New line (Shift+Enter)',

  // Translators: FormattingToolbar buttons on phones: move the block one level deeper (Indent)
  // or one level out (Outdent) in the outline; labels and tooltips.
  // #6532 — Indent and Outdent on a phone's bar, where the keyboard has no Tab.
  'toolbar.indent': 'Indent',
  'toolbar.indentTip': 'Indent block',
  'toolbar.outdent': 'Outdent',
  'toolbar.outdentTip': 'Outdent block',

  // Translators: The highlight-colour picker of the selection bubble and the Format menu.
  // "Highlight colour" is the button that opens it and the name of its row of swatches; each other
  // string names one swatch, the default highlight or a coloured one (#6759).
  'toolbar.highlightColor': 'Highlight colour',
  'toolbar.highlightDefault': 'Default highlight',
  'toolbar.highlight.red': 'Red highlight',
  'toolbar.highlight.orange': 'Orange highlight',
  'toolbar.highlight.yellow': 'Yellow highlight',
  'toolbar.highlight.green': 'Green highlight',
  'toolbar.highlight.blue': 'Blue highlight',
  'toolbar.highlight.purple': 'Purple highlight',
}
