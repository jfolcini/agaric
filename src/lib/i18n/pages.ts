/**
 * i18n namespace: pages
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const pages: Record<string, string> = {
  // Translators: Journal (JournalPage) header: "Today" is the button that jumps to today's date,
  // also shown as "(Today)" after today's date heading.
  'journal.today': 'Today',

  // Translators: The task list (the Journal's Agenda mode): Sidebar item, and the Journal header
  // title shown in place of a date while the Agenda is open. A noun.
  'journal.tasks': 'Tasks',

  // Translators: Journal header: the view-mode tabs (on narrow screens, items of a mode menu). Must
  // be short, the tabs sit side by side. Day / Week / Month show one day, week or month; Stream is
  // a continuous scroll of past days; Agenda is the task list.
  'journal.dayTab': 'Day',
  'journal.weekTab': 'Week',
  'journal.monthTab': 'Month',
  'journal.streamTab': 'Stream',
  'journal.agendaTab': 'Agenda',

  // Translators: Screen-reader names (aria-label) of the same Journal view-mode tabs, never seen;
  // "Continuous stream view" also names the Stream view itself.
  'journal.dailyView': 'Daily view',
  'journal.weeklyView': 'Weekly view',
  'journal.monthlyView': 'Monthly view',
  'journal.streamView': 'Continuous stream view',
  'journal.agendaView': 'Agenda view',

  // Translators: Journal Stream view: end-of-list message under the oldest day, when no earlier
  // journal day exists.
  'journal.streamReachedStart': "You've reached the earliest journal date.",

  // Translators: Empty state of a journal day that has no note yet: message, button, and hint under
  // it. {{date}} = a localized date like "Mon, Jun 17, 2026". In the hint, "/" is the key the user
  // types; journal templates are pages copied into each new day, chosen per space (a separate
  // collection of pages).
  'journal.noBlocks': 'No blocks for {{date}}.',
  'journal.addFirstBlock': 'Add your first block',
  'journal.emptyHint': 'Type / for commands · journal templates configurable per space',

  // Translators: Screen-reader name (aria-label) of one day's section in the Journal. {{date}} = a
  // localized date like "Mon, Jun 17, 2026".
  'journal.dayAriaLabel': 'Journal for {{date}}',

  // Translators: Week and Stream journal views: very short lowercase badge word after a number on a
  // day heading, e.g. "3 refs" = 3 references (links to that day from other pages). "due" = tasks
  // due that day.
  'journal.dueBadge': 'due',
  'journal.refsBadge': 'refs',

  // Translators: Error toast (brief pop-up message) when adding a block to a journal day fails.
  'journal.addBlockFailed': 'Failed to add block',

  // Translators: Settings › General › Journal template: the button that creates a journal template
  // page. journal.templatePageTitle is the title given to the page it creates, so it becomes a real
  // page title.
  'journal.newTemplate': 'New journal template',
  'journal.templatePageTitle': 'Journal template',

  // Translators: Journal header navigation: tooltips and aria-labels of the previous / next arrows
  // (which one depends on the current mode), the Today button's tooltip and aria-label, and the
  // date button that opens the calendar picker (read after the date, e.g.
  // "Mon, Jun 17, 2026 · Open calendar picker").
  'journal.prevDay': 'Previous day',
  'journal.prevWeek': 'Previous week',
  'journal.prevMonth': 'Previous month',
  'journal.nextDay': 'Next day',
  'journal.nextWeek': 'Next week',
  'journal.nextMonth': 'Next month',
  'journal.goToToday': 'Go to today',
  'journal.openCalendar': 'Open calendar picker',

  // Translators: Journal Month view: screen-reader name (aria-label) of the month grid. The two
  // "Failed to load" strings are error toasts when the calendar's per-day counts or its dates could
  // not be loaded.
  'journal.monthlyCalendarLabel': 'Monthly calendar',
  'journal.loadCountsFailed': 'Failed to load calendar counts',
  'journal.loadCalendarFailed': 'Failed to load calendar',

  // Translators: Toasts after a task is dragged onto a journal day or given a new date. {{date}} =
  // the new date as YYYY-MM-DD.
  'journal.rescheduled': 'Task rescheduled to {{date}}',
  'journal.rescheduleFailed': 'Failed to reschedule task',

  // Translators: Week and Stream journal views, day heading: screen-reader labels of the clickable
  // date (opens that day in the Day view) and of the count badges beside it (a click jumps to the
  // list). {{date}} = a localized date like "Mon, Jun 17, 2026"; {{count}} = number of items;
  // {{label}} = the kind of date, e.g. "Due", "Scheduled" or a property name.
  'journal.goToDailyView': 'Go to daily view for {{date}}',
  'journal.agendaCountBadge_one': '{{count}} {{label}} item, click to view',
  'journal.agendaCountBadge_other': '{{count}} {{label}} items, click to view',
  'journal.backlinkCountBadge_one': '{{count}} reference, click to view',
  'journal.backlinkCountBadge_other': '{{count}} references, click to view',

  // Screen-reader density suffix appended to a monthly day cell's aria-label
  // when the day has agenda items and/or backlinks (#1730). The decorative
  // dots/badge are aria-hidden, so these counts would otherwise be silent.
  // Translators: Journal Month view: screen-reader suffix after a day cell's full date, e.g.
  // "Monday, June 17, 2026, 2 agenda items, 1 reference". Starts lowercase; joined with commas.
  // Agenda items = tasks dated that day; references = links to that day.
  'journal.dayCellAgendaCount_one': '{{count}} agenda item',
  'journal.dayCellAgendaCount_other': '{{count}} agenda items',
  'journal.dayCellBacklinkCount_one': '{{count}} reference',
  'journal.dayCellBacklinkCount_other': '{{count}} references',

  // Translators: PageHeader (title bar of an open page): screen-reader name (aria-label) of the
  // editable page title.
  'pageHeader.pageTitle': 'Page title',

  // Translators: PageHeader kebab menu (the "Page actions" menu): items that undo or redo the
  // latest change to this page; the four short strings are the toasts (brief pop-up messages) after
  // it.
  'pageHeader.undoAction': 'Undo last page action',
  'pageHeader.redoAction': 'Redo last page action',
  'pageHeader.undone': 'Undone',
  'pageHeader.undoFailed': 'Undo failed',
  'pageHeader.redone': 'Redone',
  'pageHeader.redoFailed': 'Redo failed',

  // Translators: Toasts after the page title is edited in the PageHeader. "this space" = the
  // current space, a separate collection of pages.
  'pageHeader.pageRenamed': 'Page renamed',
  'pageHeader.renameFailed': 'Failed to rename page',
  'pageHeader.renameDuplicateTitle': 'A page with this title already exists in this space',

  // Translators: PageHeader alias row under the title (aliases = other names the page can be linked
  // by): "Also known as:" labels the alias chips (keep the colon); the three "Failed" /
  // "already used" strings are error toasts; "Trash" is the app's Trash view. The input has a
  // placeholder and an aria-label. Add / Done / Edit are small buttons: add the typed alias, stop
  // editing, start editing aliases ("Done" is not a task state). {{alias}} = an alias, in the
  // aria-label of a chip's remove (x) button.
  'pageHeader.aliases': 'Also known as:',
  'pageHeader.aliasUpdateFailed': 'Failed to update aliases',
  'pageHeader.aliasTaken':
    'That alias is already used by another page, which may be in another space or in the Trash',
  'pageHeader.loadAliasesFailed': 'Failed to load aliases',
  'pageHeader.newAliasPlaceholder': 'New alias...',
  'pageHeader.newAliasInput': 'New alias input',
  'pageHeader.addAlias': '+ Add alias',
  'pageHeader.add': 'Add',
  'pageHeader.done': 'Done',
  'pageHeader.edit': 'Edit',
  'pageHeader.removeAlias': 'Remove alias {{alias}}',

  // Translators: PageHeader kebab menu item (adds an emoji to the page title), also the aria-label
  // of the emoji button in the tag picker.
  'pageHeader.insertEmoji': 'Insert emoji',

  // Translators: PageHeader tag row: aria-label of the "+" button that opens the tag picker, and of
  // a tag chip's remove (x) button; {{name}} = a tag name.
  'pageHeader.addTag': 'Add tag',
  'pageHeader.removeTag': 'Remove tag {{name}}',
  // #1423 — inherited (derived) tag chips. The screen-reader text marks the
  // chip as derived (styling alone is not color-only); the explanation points
  // at the search filter that matches it, `under:` (#4548).
  // Translators: Inherited tag chip (a tag set on a parent block): its screen-reader text, the
  // explanation shown from an (i) button beside it, and that button's screen-reader label.
  // under:#tag is search syntax: keep it as it is.
  'pageHeader.inheritedTag': 'Inherited tag {{name}}',
  'pageHeader.inheritedTagHint':
    'Inherited from a parent block. A search matches it only with under:#tag.',
  'pageHeader.inheritedTagInfo': 'About inherited tags',
  // Translators: Tag picker popover: search input placeholder and aria-label, the popover's
  // aria-label, a button that creates a new tag ({{name}} = the typed tag name), and its empty
  // state.
  'pageHeader.searchTags': 'Search or create tag...',
  'pageHeader.searchTagsLabel': 'Search tags',
  'pageHeader.tagPicker': 'Tag picker',
  'pageHeader.createTag': 'Create "{{name}}"',
  'pageHeader.noMoreTags': 'No more tags',

  // Translators: PageHeader kebab menu: "Page actions" is the menu button's tooltip and aria-label
  // and the menu title. Template items toggle: make this page a template (copied into other pages)
  // or not; make it the journal template (copied into each new journal day) or not. The three "Add"
  // items add an alias, a tag or a property to this page.
  'pageHeader.pageActions': 'Page actions',
  'pageHeader.saveAsTemplate': 'Save as template',
  'pageHeader.removeTemplate': 'Remove template status',
  'pageHeader.setJournalTemplate': 'Set as journal template',
  'pageHeader.removeJournalTemplate': 'Remove journal template',
  'pageHeader.menuAddAlias': 'Add alias',
  'pageHeader.menuAddTag': 'Add tag',
  'pageHeader.menuAddProperty': 'Add property',

  // Translators: Templates view (opened from the Pages view header): intro text at the top
  // ("/template" is a slash command the user types, keep it as is; "placeholders below" = the list
  // at the bottom), the empty state, the search box (placeholder and aria-label), and the
  // "Journal template" badge on a template that is applied to new journal days.
  'templates.description':
    'A template is a page you can copy into any other page with /template. The placeholders below fill in when it is inserted.',
  'templates.empty': 'No templates yet. Mark a page as a template to see it here.',
  'templates.search': 'Search templates…',
  'templates.journalIndicator': 'Journal template',

  // #215 — scope badge: every template now carries a scope indicator beside
  // its title so a journal template is distinguishable from a regular page
  // template before opening it. Journal templates keep `journalIndicator`;
  // all other templates show `pageIndicator`.
  // Translators: Templates view list: badge on a regular page template and the explanation behind
  // the ⓘ beside it, with that ⓘ's screen-reader label; screen-reader labels of a row's open and
  // remove buttons ("template status" = being marked as a template); the empty state when the
  // search matches nothing; the create form at the top (button, placeholder, label) and its error
  // toasts. {{name}} = a template's page title; {{total}} = number of templates.
  'templates.pageIndicator': 'Page template',
  'templates.pageTooltip': 'A page template — inserting it creates a new page from this content.',
  'templates.scopeInfoLabel': 'About the template type of {{name}}',
  'templates.navigateLabel': 'Open template {{name}}',
  'templates.removeTemplateLabel': 'Remove template status from {{name}}',
  'templates.noSearchResults': 'No templates match your search.',
  'templates.noSearchResultsWithTotal':
    'No templates match your search ({{total}} templates total).',
  'templates.create': 'Create template',
  'templates.newTemplatePlaceholder': 'New template name...',
  'templates.newTemplateInputLabel': 'New template name',
  'templates.createFailed': 'Failed to create template',
  'templates.titleTaken': 'A page titled "{{name}}" already exists in this space',

  // #215 — dynamic-variable discoverability. These tokens are expanded by `expandTemplateVariables`
  // when a template is inserted; previously they were documented only in code comments.
  // Translators: Templates view, bottom row: "Placeholders:" labels a list of tokens like
  // "<% today %>" (keep the colon). The ⓘ beside it ("About placeholders" is its screen-reader
  // label) opens the intro and one "variable" string per token, saying what it is replaced with
  // when the template is inserted. Keep literal syntax as is: YYYY-MM-DD, HH:MM,
  // "time:/datetime:", "date+7, date-1".
  'templates.variablesHintLabel': 'Placeholders:',
  'templates.variablesHintIntro':
    'Type these anywhere in a template; each fills in when the template is inserted.',
  'templates.variablesHintInfoLabel': 'About placeholders',
  'templates.variableToday': 'Current date (YYYY-MM-DD)',
  'templates.variableTime': 'Current time (HH:MM)',
  'templates.variableDatetime': 'Current date and time',
  'templates.variablePageTitle': 'Title of the page you insert into',
  // #1450 Phase 1 — configurable formats, date math, and extra built-ins.
  'templates.variableTodayFormat': 'Date with a custom format (also time:/datetime:)',
  'templates.variableDateMath': 'Today ± N days (e.g. date+7, date-1)',
  'templates.variableWeekday': 'Current day name (e.g. Monday)',
  'templates.variableMonth': 'Current month name (e.g. June)',
  'templates.variableIsoweek': 'ISO week number',
  'templates.variableRecording':
    'On a block of its own, where a new meeting puts its recording; other inserts leave it out',
  // Translators: After the first placeholders shown in the Templates view, how many more the ⓘ
  // beside them lists. {{n}} = that count, always several.
  'templates.variablesMore': '+{{n}} more',

  // Translators: PageHeader kebab menu: "Export as Markdown" copies the page as Markdown text to
  // the clipboard; "Delete page" is a menu item, the delete dialog's confirm button and the tooltip
  // of the trash button next to the page title or on a journal day. The title and Cancel belong to
  // that confirmation dialog.
  'pageHeader.exportMarkdown': 'Export as Markdown',
  'pageHeader.deletePage': 'Delete page',
  'pageHeader.deletePageTitle': 'Delete page',
  'pageHeader.deletePageDescription':
    'This action cannot be undone. This will permanently delete the page and all its blocks.',
  'pageHeader.cancel': 'Cancel',

  // Translators: Toasts after the template menu items of the PageHeader kebab menu, and after
  // "Export as Markdown". "template status" = being marked as a template.
  'pageHeader.templateSaved': 'Saved as template',
  'pageHeader.templateRemoved': 'Template status removed',
  'pageHeader.templateFailed': 'Failed to update template status',
  'pageHeader.journalTemplateSaved': 'Set as journal template',
  'pageHeader.journalTemplateRemoved': 'Journal template removed',
  'pageHeader.journalTemplateFailed': 'Failed to update journal template',
  'pageHeader.exportCopied': 'Markdown copied to clipboard',
  'pageHeader.exportFailed': 'Export failed',

  // Translators: PageHeader kebab menu items and their toasts: save the page as a .md file;
  // "Print…" opens the system print dialog; "Copy app link" copies a link that opens this page in
  // Agaric. {{fileName}} = a file name like "Meeting notes.md"; "Downloads" is the system Downloads
  // folder.
  'pageHeader.saveMarkdownFile': 'Save as Markdown file',
  'pageHeader.print': 'Print…',
  'pageHeader.printFailed': 'Could not open the print dialog',
  'pageHeader.markdownFileSaved': 'Saved {{fileName}} to Downloads',
  'pageHeader.markdownFileSaveFailed': 'Could not save the Markdown file',
  'pageHeader.copyAppLink': 'Copy app link',
  'pageHeader.appLinkCopied': 'App link copied to clipboard',
  'pageHeader.appLinkCopyFailed': 'Could not copy the app link',

  // #5140 — source mode: the page edited as one markdown buffer.
  // Translators: "Edit as Markdown" mode, where the whole page is edited as one plain-text Markdown
  // buffer: the PageHeader kebab menu item and page-mode footer link that open it, the text area's
  // aria-label, the tooltip of the grip button in its toolbar, and the help text under the editor
  // (Enter, Shift+Enter and Escape are key names).
  'pageSource.edit': 'Edit as Markdown',
  'pageSource.editorLabel': 'Markdown source',
  'pageSource.blockMenuTip': 'Actions for the block at the cursor',
  'pageSource.hint':
    "A blank line separates blocks; list items need none. Enter starts a new block and Shift+Enter a new line in the same one. Each block keeps its id while you edit it, and a block you cut and paste moves. Deleting a block's lines deletes it, and joining two blocks deletes the second. Escape leaves the editor, asking first when you changed it.",

  // Translators: Edit as Markdown: note above the editor when unsaved edits were brought back. The
  // "Points to" strings are read by screen readers for a block-reference token at the cursor;
  // {{title}} = the referenced page or block's text. The last pair is a warning toast after saving:
  // {{count}} = number of references, {{tokens}} = a comma-separated list of the raw tokens.
  'pageSource.draftRestored': 'Restored your unsaved edits.',
  'pageSource.ulidHint': 'Points to {{title}}',
  'pageSource.ulidHintDeleted': 'Points to {{title}}, deleted or missing',
  'pageSource.unresolvedTokens_one': '{{count}} reference points to nothing: {{tokens}}',
  'pageSource.unresolvedTokens_other': '{{count}} references point to nothing: {{tokens}}',

  // Translators: Edit as Markdown: notice above a read-only box holding unsaved edits from an older
  // app version, its "Copy earlier edits" button, and the toasts after copying.
  'pageSource.legacyDraft':
    "Unsaved edits from an earlier version of Edit as Markdown cannot be opened here. Copy what you need from them: saving, discarding or editing this page's Markdown replaces them.",
  'pageSource.copyLegacyDraft': 'Copy earlier edits',
  'pageSource.legacyDraftCopied': 'Earlier edits copied',
  'pageSource.copyFailed': 'Failed to copy the earlier edits',

  // Translators: Edit as Markdown: error messages if the page text cannot be loaded or saved, and
  // the toast title after a successful save.
  'pageSource.loadFailed': 'Failed to load the markdown source',
  'pageSource.saveFailed': 'Failed to save the markdown source',
  'pageSource.saved': 'Markdown saved',

  // Translators: Edit as Markdown: details under the save toast. The counts are joined into one
  // line, e.g. "2 blocks deleted, 3 created, 1 edited, 1 moved" (created / edited / moved refer to
  // blocks). "Created:" is followed by a list of new page and tag names,
  // "Saved differently than written:" by a list of warnings (keep both colons). undoStale is a
  // toast when Undo is pressed after the page changed again.
  'pageSource.countDeleted_one': '{{count}} block deleted',
  'pageSource.countDeleted_other': '{{count}} blocks deleted',
  'pageSource.countCreated_one': '{{count}} created',
  'pageSource.countCreated_other': '{{count}} created',
  'pageSource.countEdited_one': '{{count}} edited',
  'pageSource.countEdited_other': '{{count}} edited',
  'pageSource.countMoved_one': '{{count}} moved',
  'pageSource.countMoved_other': '{{count}} moved',
  'pageSource.reportCreated': 'Created:',
  'pageSource.reportWarnings': 'Saved differently than written:',
  'pageSource.undoStale': 'The page changed after the save, so it can no longer be undone here',

  // Translators: Edit as Markdown: confirmation dialogs (ConfirmDialog). The first asks before
  // leaving with unsaved changes ("Discard" confirms; the cancel button is "Keep editing"); the
  // second asks before saving an empty text, which deletes the whole page content.
  'pageSource.discardTitle': 'Discard your changes?',
  'pageSource.discardBody':
    'Your changes to the Markdown are not saved. Discarding them leaves the page as it is.',
  'pageSource.discard': 'Discard',
  'pageSource.deleteAllTitle': 'Delete every block on this page?',
  'pageSource.deleteAllBody':
    "The source is empty, so saving it deletes every block on this page and the page's properties, aliases and tags.",
  'pageSource.deleteAll': 'Delete all',

  // Translators: Edit as Markdown: dialog shown on save when the page was changed elsewhere
  // (another device or window); the description is followed by a list of the changed lines.
  // "Added:", "Removed:" and "Changed:" are screen-reader prefixes before each listed line, also in
  // the Changes tab (keep the colon).
  'pageSource.conflictTitle': 'This page changed',
  'pageSource.conflictDescription': 'Since you opened the source, this changed elsewhere:',
  'pageSource.onlyOrderChanged': 'Only the order of blocks changed.',
  'pageSource.changeAdded': 'Added:',
  'pageSource.changeRemoved': 'Removed:',
  'pageSource.changeChanged': 'Changed:',

  // Translators: Edit as Markdown: "Show" is the screen-reader name (aria-label) of the tab strip
  // with the Edit / Preview / Changes tabs; "Edit" is the first tab (a verb; the text editor
  // itself).
  'pageSource.view': 'Show',
  'pageSource.modeEdit': 'Edit',

  // Translators: Page mode switch in the PageHeader and on a journal day: "Editing mode" is its
  // aria-label; Blocks / Page are its two short options, edit block by block or the whole page as
  // one document. "Page" is also a link in the Edit as Markdown editor that switches to page mode.
  // The hint is the tooltip of "Page", followed by a keyboard shortcut in parentheses.
  // "Edit as page" / "Edit as blocks" is the same switch as a "Page actions" menu item on phones;
  // "Page text" is the aria-label of the page-mode editor.
  'pageMode.switchLabel': 'Editing mode',
  'pageMode.blocks': 'Blocks',
  'pageMode.page': 'Page',
  'pageMode.pageHint': 'Edit the whole page as one document',
  'pageMode.editAsPage': 'Edit as page',
  'pageMode.editAsBlocks': 'Edit as blocks',
  'pageMode.editorLabel': 'Page text',

  // Translators: Page mode: tooltip of the task button in the toolbar (TODO is the task marker); an
  // error toast; the placeholder of an empty page ([[, @ and (( are characters the user types, keep
  // them); and the two links in the footer under the page, read as "Supports Markdown. Type / for
  // commands", each opening a reference side sheet.
  'pageMode.todoToggleTip': 'Set or clear TODO',
  'pageMode.saveFailed':
    'Some changes to this page could not be saved yet; they are tried again with your next edit.',
  'pageMode.placeholder':
    'Type [[ to link, @ to tag, (( to reference a block · Shift+Enter for a line break',
  'pageMode.footerHint.markdown': 'Supports Markdown',
  'pageMode.footerHint.commands': 'Type / for commands',

  // Translators: Reference side sheets opened from the page-mode footer: one lists Markdown syntax,
  // the other slash commands. Each has a title, a description and a filter box (placeholder and
  // aria-label). {{filter}} = the text typed in the filter box.
  'referenceSheet.markdown.title': 'Markdown',
  'referenceSheet.markdown.description': 'What you can type, and what it becomes.',
  'referenceSheet.markdown.filter': 'Filter Markdown',
  'referenceSheet.commands.title': 'Slash commands',
  'referenceSheet.commands.description': 'Type / in the text, then a command’s name.',
  'referenceSheet.commands.filter': 'Filter commands',
  'referenceSheet.noMatches': 'Nothing matches “{{filter}}”',

  // Translators: Page mode info toasts. keptAsNew: blocks the user was editing were deleted on
  // another device or window. switchedToBlocks: {{reason}} = a full sentence saying why, e.g.
  // pageMode.blocked.overCap.
  'pageMode.keptAsNew_one':
    'A block you were editing was deleted elsewhere. Your text is kept as a new block.',
  'pageMode.keptAsNew_other':
    '{{count}} blocks you were editing were deleted elsewhere. Your text is kept as new blocks.',
  'pageMode.switchedToBlocks': '{{reason}} This page is back in block mode.',

  // Translators: Page mode floating toolbars over a link, a table or a code block: their
  // screen-reader names (aria-label), the code block's "Copy code" button (tooltip and aria-label)
  // and its toasts.
  'pageMode.linkActions': 'Link actions',
  'pageMode.tableActions': 'Table actions',
  'pageMode.codeActions': 'Code block actions',
  'pageMode.codeCopy': 'Copy code',
  'pageMode.codeCopied': 'Code copied to clipboard',
  'pageMode.codeCopyFailed': "Couldn't copy the code",

  // Translators: Why page mode cannot open this page: inserted as {{reason}} into
  // pageMode.switchedToBlocks, also shown alone in a toast and as the disabled reason of the Page
  // switch. {{cap}} = the block limit; {{blocks}} = this page's number of blocks. blockedInfo =
  // screen-reader label of the (i) button beside the Page switch that shows that reason.
  'pageMode.blocked.overCap':
    'Page mode opens pages of up to {{cap}} blocks; this one has {{blocks}}.',
  'pageMode.blockedInfo': 'Why page mode is unavailable',

  // Translators: Edit as Markdown: the Preview and Changes tabs (nouns; "Changes" also names the
  // line diff), the Save button with the number of changes ({{count}}), the empty Changes and
  // Preview tabs, and a collapsed row of unchanged lines in the diff ({{count}} = lines).
  'pageSource.preview': 'Preview',
  'pageSource.changes': 'Changes',
  'pageSource.saveChanges_one': 'Save ({{count}} change)',
  'pageSource.saveChanges_other': 'Save ({{count}} changes)',
  'pageSource.noChanges': 'No changes to the Markdown yet.',
  'pageSource.previewEmpty': 'Saved like this, the page has no blocks.',
  'pageSource.unchangedLines_one': '{{count}} unchanged line',
  'pageSource.unchangedLines_other': '{{count}} unchanged lines',

  // Translators: Edit as Markdown buttons: "Keep editing" closes the discard or conflict dialog and
  // returns to the editor. In the conflict dialog, Merge and Overwrite each have an explanation
  // shown under the dialog; the third button is "Reload".
  'pageSource.keepEditing': 'Keep editing',
  'pageSource.merge': 'Merge',
  'pageSource.mergeHint':
    'Merge saves your text with the changes made elsewhere folded in. Where both sides changed a block differently, both versions are kept.',
  'pageSource.overwrite': 'Overwrite',
  'pageSource.overwriteWarning':
    'Overwrite keeps your text over everything changed elsewhere since you opened it: edits made there are reverted, blocks added there are deleted, blocks deleted there come back as new copies, and a page renamed there is linked by its old name, which creates a new page.',

  // Translators: Page deletion: two toasts, the body of the delete confirmation dialog (PageHeader
  // and Pages view), and the tooltip and aria-label of the bookmark button next to the page title
  // or on a journal day. "trash" = the Trash view.
  'pageHeader.pageDeleted': 'Page deleted',
  'pageHeader.deleteFailed': 'Failed to delete page',
  'pageHeader.deleteConfirm': 'Delete this page? It can be restored from trash.',
  'pageHeader.addBookmark': 'Bookmark this page',
  'pageHeader.removeBookmark': 'Remove this page from bookmarks',

  // Part A — shared toast/restore copy for the page-delete flow
  // surfaced by both `PageHeader` and journal `DaySection` via
  // `usePageDeleteAction`. Kept in its own `pageDeleteAction.*` namespace
  // so journal callers don't have to import `pageHeader.*` keys.
  // Translators: Toasts after a page is deleted (from the PageHeader, a journal day or the Pages
  // view). "Undo" and "Retry" are buttons inside the toast.
  'pageDeleteAction.deleted': 'Page deleted',
  'pageDeleteAction.deleteFailed': 'Failed to delete page',
  'pageDeleteAction.retry': 'Retry',
  'pageDeleteAction.undo': 'Undo',
  'pageDeleteAction.restored': 'Page restored',
  'pageDeleteAction.restoreFailed': 'Failed to restore page',

  // Journal-specific confirm copy ("Delete the note for {{date}}?") —
  // higher-stakes than a regular page delete, so the dialog body calls
  // out that the day's blocks go to Trash but can be restored.
  // Translators: Confirmation dialog when deleting a journal day's note (title and body). {{date}}
  // = a localized date like "Mon, Jun 17, 2026".
  'journal.deleteDayTitle': 'Delete the note for {{date}}?',
  'journal.deleteDayDescription':
    "This moves the day's note (and its blocks) to Trash. You can restore it from Trash or with Undo.",

  // Translators: Pages view tree of namespaced pages (titles with "/", e.g. "Projects/Work"):
  // aria-labels of a row's delete button and of the "+" button that creates a page under it.
  // {{path}} = a full page path like "Projects/Work".
  'pageTree.delete': 'Delete {{path}}',
  'pageTree.createUnder': 'Create page under {{path}}',

  // Translators: Pages view: "New Page" is the header button that opens the New page dialog; the
  // two other strings are the empty state of the list (the second when journal pages are hidden by
  // the default filter).
  'pageBrowser.newPage': 'New page',
  'pageBrowser.noPages': 'No pages yet.',
  // True with or without journal pages: the default chip hides them (#5370).
  'pageBrowser.noPagesOutsideJournal': 'No pages outside the journal yet.',

  // Translators: Empty state when the current space has no page open: message, description, and a
  // button that opens the Journal view.
  'pageEditor.empty.message': 'No page open',
  'pageEditor.empty.description':
    "This space doesn't have a page open yet. Head to the Journal to start writing, or browse your pages.",
  'pageEditor.empty.goToJournal': 'Go to Journal',

  // Translators: Pages view: button in the empty state; "Untitled" is the fallback title of a page
  // with no title; "Load more" is the button at the bottom of the list and "Loading..." its busy
  // text.
  'pageBrowser.createFirst': 'Create your first page',
  'pageBrowser.untitled': 'Untitled',
  'pageBrowser.loadMore': 'Load more',
  'pageBrowser.loading': 'Loading...',

  // Translators: Pages view: confirmation dialog when deleting a page from the list (title, body,
  // confirm and cancel buttons), the related success toast, and the aria-label of a row's trash
  // button. {{name}} = the page title.
  'pageBrowser.deletePage': 'Delete page?',
  'pageBrowser.deleteDescription':
    'This will permanently delete the page \u201C{{name}}\u201D and all its child blocks. This action cannot be undone.',
  'pageBrowser.deleteSuccess': 'Page deleted',
  'pageBrowser.deleteCascadeWarning': 'This will permanently delete the page and all its blocks.',
  'pageBrowser.delete': 'Delete',
  'pageBrowser.cancel': 'Cancel',
  'pageBrowser.deleteButton': 'Delete page',

  // Translators: Pages view errors: toasts when the list cannot load or a page cannot be deleted;
  // the create errors and "Loading spaces…" appear in the New page dialog. {{error}} = a raw
  // technical error message.
  'pageBrowser.loadFailed': 'Failed to load pages',
  'pageBrowser.createFailed': 'Failed to create page: {{error}}',
  'pageBrowser.duplicateName': 'A page with that name already exists.',
  'pageBrowser.deleteFailed': 'Failed to delete page: {{error}}',
  'pageBrowser.spaceNotReady': 'Loading spaces\u2026 try again in a moment',

  // Translators: Pages view search box (placeholder and aria-label), its empty state, and a button
  // offering to create a page with the typed name (also in the command palette). {{name}} = the
  // typed text; use the quotation marks of your language.
  'pageBrowser.searchPlaceholder': 'Search pages...',
  'pageBrowser.noMatches': 'No matching pages',
  'pageBrowser.createPageNamed': 'Create page \u201C{{name}}\u201D',

  // Translators: New page dialog: title, description, the title input's aria-label and placeholder
  // ("Untitled", shown greyed out). {{path}} = the parent namespace the page is created in, like
  // "Projects/Work".
  'newPageDialog.title': 'New page',
  'newPageDialog.description':
    'Pages with a similar name are listed below, so you can open one instead.',
  'newPageDialog.inputLabel': 'New page title',
  'newPageDialog.placeholder': 'Untitled',
  'newPageDialog.parentPath': 'Inside {{path}}',

  // Translators: New page dialog: list of pages with a similar name and the messages when the title
  // is already taken. {{title}} = a page title; {{alias}} = another name of that page.
  // "alias: {{alias}}" is small text under a similar page (keep it short). "Open" is a verb (button
  // on each similar page; {{title}} is in its aria-label); "Open it" opens the existing page
  // instead of creating one.
  'newPageDialog.similarHeading': 'Similar pages',
  'newPageDialog.noSimilar': 'No similar pages',
  'newPageDialog.exists': 'A page named \u201C{{title}}\u201D already exists.',
  'newPageDialog.aliasExists': '\u201C{{alias}}\u201D is an alias of \u201C{{title}}\u201D.',
  'newPageDialog.aliasOf': 'alias: {{alias}}',
  'newPageDialog.open': 'Open',
  'newPageDialog.openPage': 'Open {{title}}',
  'newPageDialog.openExisting': 'Open it',
  'newPageDialog.create': 'Create',
  'newPageDialog.cancel': 'Cancel',

  // Translators: Pages view header: the page count next to the search box. {{count}} = number of
  // pages; while searching, {{loaded}} of {{total}} pages match; with filters only, {{count}}
  // matching pages.
  'pageBrowser.countAll_one': '{{count}} page',
  'pageBrowser.countAll_other': '{{count}} pages',
  'pageBrowser.countFiltered': '{{loaded}} of {{total}} matching',
  // Chips active without a text query: numerator and
  // denominator must share a basis, so show just the filtered total
  // ("312 matching pages") instead of "loaded of total".
  'pageBrowser.countMatching_one': '{{count}} matching page',
  'pageBrowser.countMatching_other': '{{count}} matching pages',

  // Translators: Pages view header: the sort-order dropdown (aria-label), its options (short;
  // "Last opened" = pages you opened most recently), and its tooltip.
  'pageBrowser.sortLabel': 'Sort order',
  'pageBrowser.sortRecent': 'Last opened',
  'pageBrowser.sortAlphabetical': 'Alphabetical',
  'pageBrowser.sortCreated': 'Created',
  'pageBrowser.sortRecentlyModified': 'Last edited',
  'pageBrowser.sortMostLinked': 'Most linked',
  'pageBrowser.sortMostContent': 'Most content',
  'pageBrowser.sortPersistedTooltip': 'Your sort choice is saved across sessions',

  // #5269 — the Pages header's Trash button while its count badge shows.
  // Translators: Pages view header: name of the Trash button while items are in the Trash.
  // {{count}} = number of items in the Trash.
  'pageBrowser.viewButtons.trashWithCount_one': 'Trash, {{count}} item',
  'pageBrowser.viewButtons.trashWithCount_other': 'Trash, {{count}} items',

  // #2003 piece 1 — saved Pages views (sort + filters snapshot).
  // Translators: Pages view saved views (a saved sort and set of filters): the dropdown button in
  // the header (also a heading in the phone menu), its menu (empty state, "Save current view…"
  // item, screen-reader labels of each view's apply and delete buttons) and the toasts after
  // applying, deleting or restoring a view. {{name}} = a saved view's name.
  'pageBrowser.savedViews.trigger': 'Saved views',
  // Translators: Phones only: tooltip and aria-label of the "more" (⋮) button in the Pages view
  // header; "Pages" is the view name.
  'pageBrowser.moreMenu': 'More Pages options',
  'pageBrowser.savedViews.triggerActive': 'Saved views — {{name}} applied',
  'pageBrowser.savedViews.empty': 'No saved views yet',
  'pageBrowser.savedViews.saveCurrentView': 'Save current view…',
  'pageBrowser.savedViews.apply': 'Apply view {{name}}',
  'pageBrowser.savedViews.delete': 'Delete view {{name}}',
  'pageBrowser.savedViews.deleted': 'Deleted view "{{name}}"',
  'pageBrowser.savedViews.restored': 'Restored view "{{name}}"',

  // Translators: Saved view errors (toasts). A view cannot be named like a date because dates
  // (YYYY-MM-DD) are journal page titles. {{name}} = the view name the user typed.
  'pageBrowser.savedViews.nameTaken':
    'A page or view named "{{name}}" already exists in this space',
  'pageBrowser.savedViews.nameIsDate': 'A view cannot be named like a date: "{{name}}"',
  'pageBrowser.savedViews.saveFailed': 'Could not save the view',
  'pageBrowser.savedViews.deleteFailed': 'Could not delete the view',
  'pageBrowser.savedViews.restoreFailed': 'Could not restore the view',

  // Translators: "Save current view" dialog: title, description, name field (placeholder and
  // label), validation errors ({{max}} = the maximum number of characters), and its Save / Cancel
  // buttons.
  'pageBrowser.savedViews.dialogTitle': 'Save current view',
  'pageBrowser.savedViews.dialogDescription':
    'Saves the current sort and filters so you can reapply them later.',
  'pageBrowser.savedViews.namePlaceholder': 'View name…',
  'pageBrowser.savedViews.nameLabel': 'Name',
  'pageBrowser.savedViews.nameEmpty': 'Enter a name for this view',
  'pageBrowser.savedViews.nameTooLong': 'Name must be {{max}} characters or fewer',
  'pageBrowser.savedViews.save': 'Save',
  'pageBrowser.savedViews.cancel': 'Cancel',

  // Translators: Pages view list: aria-label of a row's bookmark button; the list's screen-reader
  // names; section headings when bookmarked pages are listed first, and their screen-reader
  // versions. {{count}} = pages in the section.
  'pageBrowser.addBookmark': 'Bookmark page',
  'pageBrowser.removeBookmark': 'Remove page from bookmarks',
  'pageBrowser.pageList': 'Page list',
  'pageBrowser.pageListGrouped': 'Page list, grouped by bookmarked',
  'pageBrowser.bookmarksSection': 'Bookmarks',
  'pageBrowser.pagesSection': 'Pages',
  'pageBrowser.bookmarksSectionLabel_one': 'Bookmarks, {{count}} page',
  'pageBrowser.bookmarksSectionLabel_other': 'Bookmarks, {{count}} pages',
  'pageBrowser.pagesSectionLabel_one': 'Pages, {{count}} page',
  'pageBrowser.pagesSectionLabel_other': 'Pages, {{count}} pages',

  // #81 / multi-select + batch toolbar.
  // Translators: Pages view multi-select: aria-label of a row's checkbox, and the batch toolbar
  // shown while pages are selected. "Trash" is a verb here (move the selected pages to the Trash).
  // "Move to space" moves them to another space (a separate collection of pages). The pickers have
  // a placeholder; Add / Move confirm, Cancel closes the picker.
  'pageBrowser.select.toggle': 'Select page',
  'pageBrowser.select.selectAll': 'Select all',
  'pageBrowser.select.clear': 'Clear selection',
  'pageBrowser.batch.trash': 'Trash',
  'pageBrowser.batch.addTag': 'Add tag',
  'pageBrowser.batch.moveToSpace': 'Move to space',
  'pageBrowser.batch.tagPlaceholder': 'Choose a tag…',
  'pageBrowser.batch.spacePlaceholder': 'Choose a space…',
  'pageBrowser.batch.confirmAddTag': 'Add',
  'pageBrowser.batch.confirmMove': 'Move',
  'pageBrowser.batch.cancel': 'Cancel',

  // Translators: Batch toolbar, moving the selected pages to the Trash: toasts, the confirmation
  // dialog (title, body, confirm button), and the toasts after Undo ({{count}} = number of pages).
  // retryNoSelection appears when Retry is pressed after the selection was cleared.
  'pageBrowser.batch.trashed_one': 'Moved {{count}} page to Trash',
  'pageBrowser.batch.trashed_other': 'Moved {{count}} pages to Trash',
  'pageBrowser.batch.trashFailed': 'Failed to trash the selected pages',
  // #3703 item 3 — Retry on the trash-failure toast re-opens the confirm, which
  // needs a selection to confirm. Say so rather than doing nothing silently.
  'pageBrowser.batch.retryNoSelection': 'Nothing selected — select the pages again to retry',
  'pageBrowser.batch.trashConfirmTitle_one': 'Move {{count}} page to Trash?',
  'pageBrowser.batch.trashConfirmTitle_other': 'Move {{count}} pages to Trash?',
  'pageBrowser.batch.trashConfirmDescription_one':
    'The page and everything under it moves to Trash. You can restore it from there.',
  'pageBrowser.batch.trashConfirmDescription_other':
    'The {{count}} pages and everything under them move to Trash. You can restore them from there.',
  'pageBrowser.batch.trashConfirmAction': 'Move to Trash',
  'pageBrowser.batch.trashUndone_one': 'Restored {{count}} page',
  'pageBrowser.batch.trashUndone_other': 'Restored {{count}} pages',
  'pageBrowser.batch.trashUndoFailed': 'Failed to restore the pages',

  // Translators: Batch toolbar: toasts after tagging or moving the selected pages ({{count}} =
  // number of pages), and the disabled item shown when a picker has nothing to offer.
  'pageBrowser.batch.tagged_one': 'Tagged {{count}} page',
  'pageBrowser.batch.tagged_other': 'Tagged {{count}} pages',
  'pageBrowser.batch.addTagFailed': 'Failed to tag the selected pages',
  'pageBrowser.batch.moved_one': 'Moved {{count}} page',
  'pageBrowser.batch.moved_other': 'Moved {{count}} pages',
  'pageBrowser.batch.moveFailed': 'Failed to move the selected pages',
  'pageBrowser.batch.noTags': 'No tags in this space yet',
  'pageBrowser.batch.noSpaces': 'No other spaces to move to',

  // Translators: Batch toolbar: button that bookmarks the selected pages or removes their
  // bookmarks, and its longer tooltip and aria-label.
  'pageBrowser.batch.bookmark': 'Bookmark',
  'pageBrowser.batch.removeBookmark': 'Remove bookmark',
  'pageBrowser.batch.bookmarkSelected': 'Bookmark the selected pages',
  'pageBrowser.batch.removeBookmarkSelected': 'Remove the selected pages from bookmarks',

  // #2003 — bulk set-property picker.
  // Translators: Batch toolbar: "Set property" button and its pickers (property, value, date:
  // placeholders and aria-labels). "Set" applies the value; "Clear" is the first option of the
  // value list and removes the value.
  'pageBrowser.batch.setProperty': 'Set property',
  'pageBrowser.batch.propertyPlaceholder': 'Choose a property…',
  'pageBrowser.batch.valuePlaceholder': 'Choose a value…',
  'pageBrowser.batch.datePlaceholder': 'Choose a date',
  'pageBrowser.batch.confirmSetProperty': 'Set',
  'pageBrowser.batch.clearValue': 'Clear',

  // Translators: Batch toolbar property picker: names of the properties it can set, then the
  // options of the task state (To-do / Doing / Done are task states, not verbs) and of the
  // priority.
  'pageBrowser.batch.propTodoState': 'To-do state',
  'pageBrowser.batch.propPriority': 'Priority',
  'pageBrowser.batch.propDueDate': 'Due date',
  'pageBrowser.batch.propScheduledDate': 'Scheduled date',
  'pageBrowser.batch.todoTodo': 'To-do',
  'pageBrowser.batch.todoDoing': 'Doing',
  'pageBrowser.batch.todoDone': 'Done',
  'pageBrowser.batch.priorityHigh': 'High',
  'pageBrowser.batch.priorityMedium': 'Medium',
  'pageBrowser.batch.priorityLow': 'Low',

  // Translators: Batch toolbar: toasts after setting a property on the selected pages. {{count}} =
  // number of pages.
  'pageBrowser.batch.propertySet_one': 'Updated {{count}} page',
  'pageBrowser.batch.propertySet_other': 'Updated {{count}} pages',
  'pageBrowser.batch.setPropertyFailed': 'Failed to update the selected pages',

  // Translators: Properties of a page (and of a block, in the BlockPropertyDrawer side sheet):
  // error toasts. "Toggle properties" is the screen-reader name of the button that shows or hides
  // them.
  'pageProperty.loadFailed': 'Failed to load properties',
  'pageProperty.saveFailed': 'Failed to save property',
  'pageProperty.deleteFailed': 'Failed to delete property',
  'pageProperty.addFailed': 'Failed to add property',
  'pageProperty.toggleLabel': 'Toggle properties',

  // Translators: Collapsible "Properties" heading under the page title (followed by the count in
  // parentheses) and the "Add property" picker: button and its aria-label (also the picker's title
  // on phones), the picker's screen-reader name, its search box ("definitions" = named properties
  // with a value type), and a button creating a property named {{name}} (the typed name).
  // addPropertyDisabledInfo = screen-reader label of the (i) button beside a disabled "Add
  // property" button that says why.
  'pageProperty.propertiesButton': 'Properties',
  'pageProperty.addPropertyLabel': 'Add property',
  'pageProperty.addPropertyButton': 'Add property',
  'pageProperty.addPropertyDisabledInfo': 'Why properties cannot be added yet',
  'pageProperty.pickerLabel': 'Property picker',
  'pageProperty.searchPlaceholder': 'Search definitions...',
  'pageProperty.searchLabel': 'Search definitions',
  'pageProperty.createButton': 'Create "{{name}}"',

  // Translators: Add property picker, creating a new property: the "Value type" dropdown and its
  // options, lowercase as shown: text, number, date, select (one choice from a list of options),
  // ref (a link to another page), boolean (yes / no), url (web address). Then the button that
  // creates the property.
  'pageProperty.valueTypeLabel': 'Value type',
  'pageProperty.textType': 'text',
  'pageProperty.numberType': 'number',
  'pageProperty.dateType': 'date',
  'pageProperty.datetimeType': 'datetime',
  'pageProperty.selectType': 'select',
  'pageProperty.refType': 'ref',
  'pageProperty.booleanType': 'boolean',
  'pageProperty.urlType': 'url',
  'pageProperty.createDefinitionButton': 'Create definition',

  // Translators: Property row editors (page properties, BlockPropertyDrawer, query result tables):
  // mostly screen-reader labels of fields and buttons. {{key}} = a property name, {{url}} = a web
  // address, {{option}} = one option of a select property. "—" (a dash) is the "no value" option of
  // a select; options are edited in a popover with a new-option input, an add button and
  // "Save options". The last string is a toast when the page list for a page-link property cannot
  // load.
  'pageProperty.updateOptionsFailed': 'Failed to update options',
  'pageProperty.valueLabel': '{{key}} value',
  'pageProperty.openLinkLabel': 'Open {{url}}',
  'pageProperty.emptyOption': '\u2014',
  'pageProperty.editOptionsLabel': 'Edit options for {{key}}',
  'pageProperty.removeOptionLabel': 'Remove option {{option}}',
  'pageProperty.newOptionPlaceholder': 'New option...',
  'pageProperty.newOptionLabel': 'New option value',
  'pageProperty.addOptionLabel': 'Add option',
  'pageProperty.saveOptionsButton': 'Save options',
  'pageProperty.deletePropertyLabel': 'Delete property {{key}}',
  'pageProperty.loadPagesFailed': 'Failed to load pages',

  // Translators: Templates view: toasts after removing a page's template status (the page stays, it
  // is no longer a template). {{name}} = the page title.
  'templates.removeTemplateFailed': 'Failed to remove template status',
  'templates.templateRemoved': 'Removed template status from {{name}}',

  // Translators: Journal: "Date picker" is the title and screen-reader name of the calendar picker
  // (also of a block's date picker); the mode labels name the view-mode tabs and the phone mode
  // menu ({{mode}} = the current mode, e.g. "Week"). "Type a date" is the aria-label of a field
  // where a date can be typed in words. In the calendar, the month name opens the Month view and
  // each week number opens that week ({{weekNum}} = the week number).
  'journal.datePickerLabel': 'Date picker',
  'journal.viewModeLabel': 'Journal view mode',
  'journal.viewModeMenuLabel': 'Journal view mode: {{mode}}',
  'journal.typeDateLabel': 'Type a date',
  'journal.monthlyViewButtonLabel': 'Go to monthly view',
  'journal.goToWeek': 'Go to week {{weekNum}}',

  // Translators: PageHeader: screen-reader name of the breadcrumb (the path above the title of a
  // page named like "Projects/Work").
  'pageHeader.breadcrumbLabel': 'Page breadcrumb',

  // Translators: Templates view: explanation behind the ⓘ beside the "Journal template" badge.
  'templates.journalTooltip':
    'This template is automatically applied when creating new journal entries',

  // Translators: Legend under the Journal's calendar picker: short labels next to colored dots.
  // Page = the day has a journal page; Due / Scheduled = tasks due or scheduled that day; Property
  // = other date properties. legendLabel is its screen-reader name.
  'journal.legendLabel': 'Calendar dot legend',
  'journal.legendPage': 'Page',
  'journal.legendDue': 'Due',
  'journal.legendScheduled': 'Scheduled',
  'journal.legendProperty': 'Property',

  // Translators: Templates view: confirmation dialog (ConfirmDialog) before removing a page's
  // template status. {{name}} = the page title.
  'templates.removeConfirmTitle': 'Remove template status',
  'templates.removeConfirmDesc':
    'Remove template status from "{{name}}"? Pages already created from this template will not be affected.',

  // Translators: Pages view: screen-reader announcement after "Load more" adds pages. {{count}} =
  // pages added.
  'pageBrowser.loadedMorePages_one': 'Loaded {{count}} more page',
  'pageBrowser.loadedMorePages_other': 'Loaded {{count}} more pages',

  // Translators: Collapsible "Info" bar under a page: its heading and screen-reader toggle label,
  // then one line joined with " · ", e.g. "120 words · 14 blocks · Created Jun 17, 2026". {{date}}
  // = a localized date; "Created {{date}}" is also the tooltip of a date shown next to pages that
  // share a title.
  'metadata.label': 'Info',
  'metadata.toggleLabel': 'Toggle page metadata',
  'metadata.wordCount_one': '{{count}} word',
  'metadata.wordCount_other': '{{count}} words',
  'metadata.blockCount_one': '{{count}} block',
  'metadata.blockCount_other': '{{count}} blocks',
  'metadata.created': 'Created {{date}}',

  // Translators: PageHeader kebab menu items: open the outline (list of the page's headings), show
  // the page in the Graph view, open this page's edit history.
  'pageHeader.openOutline': 'Open outline',
  'pageHeader.showInGraph': 'Show in graph',
  'pageHeader.pageHistory': 'Page history',

  // Translators: Outline side sheet listing the page's headings: title, empty state and
  // screen-reader name. pages.tags.empty is the empty state of the tag picker when every tag is
  // already added.
  'outline.title': 'Outline',
  'outline.empty': 'No headings found',
  'outline.navLabel': 'Page outline',
  'pages.tags.empty': 'No more tags',
  'pages.outline.empty': 'No headings found',

  // #6278: `from` and `to` are the one page's titles; `count` the pages renamed.
  // Translators: Info toast when the app renamed pages because another page in the same space had
  // the same name (for example after a sync between devices). {{from}} / {{to}} = the old and new
  // title (the new one gets a number, like "Notes (2)"); {{count}} = number of pages renamed.
  // "History" is the History view.
  'pages.nameTieRenamed_one':
    'Renamed “{{from}}” to “{{to}}”: another page in this space already had that name.',
  'pages.nameTieRenamed_other':
    'Renamed {{count}} pages whose names another page in their space already had. History lists each rename.',

  // Translators: Pages view tree: screen-reader labels of the button that expands or collapses a
  // namespace (a folder of pages named like "Projects/..."); a hybrid namespace is also a page
  // itself. {{path}} = a page path like "Projects/Work".
  'pageTree.toggleNamespace': 'Toggle {{path}} namespace',
  'pageTree.toggleHybrid': 'Toggle {{path}} (hybrid namespace)',

  // Bug 2 — child-pages tree section at the bottom of PageEditor.
  // Renders only when the current page actually has descendants (the
  // section hides itself otherwise), so `pagesTree.empty` is reserved
  // for the deliberate "no descendants" copy if a caller chooses to
  // surface it (e.g. a debug view).
  // Translators: Collapsible section at the bottom of a page listing its child pages (pages titled
  // with this page's title and "/"): heading, empty state, screen-reader name. {{title}} = this
  // page's title.
  'pagesTree.title': 'Pages tree',
  'pagesTree.empty': 'No child pages.',
  'pagesTree.ariaLabel': 'Child pages of {{title}}',

  // Translators: Error message shown in place of the page's property table when it fails to
  // display.
  'pageProperty.tableErrorBoundary': 'Failed to load properties.',

  // PageRow metadata badges
  // Translators: Pages view row: screen-reader text for the icons after a page title. inbound =
  // links from other pages; children = blocks on the page; {{relative}} = a short time like "3d",
  // "2h" or the word "never" (lowercase, shown when there is no date). The four lowercase words are
  // very short badges shown after "#", e.g. "#todos".
  'pageBrowser.metadata.inbound_one': '{{count}} inbound link',
  'pageBrowser.metadata.inbound_other': '{{count}} inbound links',
  'pageBrowser.metadata.children_one': '{{count}} child block',
  'pageBrowser.metadata.children_other': '{{count}} child blocks',
  'pageBrowser.metadata.lastModified': 'Last modified {{relative}}',
  'pageBrowser.metadata.never': 'never',
  'pageBrowser.metadata.propertyTag': 'tags',
  'pageBrowser.metadata.propertyTodo': 'todos',
  'pageBrowser.metadata.propertyScheduled': 'scheduled',
  'pageBrowser.metadata.propertyDue': 'due',

  // Phase 3+4 — compound-filter chip-row + Add-Filter popover
  // Translators: Filter chips of the Pages view and Advanced Query: the "Add filter" button and its
  // popover (aria-label, warning when many filters are set), the screen-reader names of the chip
  // list and of each chip and its remove (x) button. {{label}} = a chip's text, like "tag: work".
  'pageBrowser.filter.addFilter': 'Add filter',
  'pageBrowser.filter.addFilterDialogLabel': 'Add a filter',
  'pageBrowser.filter.appliedFiltersLabel': 'Active filters',
  'pageBrowser.filter.filterGroup': 'Filter: {{label}}',
  'pageBrowser.filter.removeFilter': 'Remove filter {{label}}',
  'pageBrowser.filter.aboutFilter': 'About the {{label}} filter',
  'pageBrowser.filter.manyFiltersWarning': 'Many filters can slow the view.',

  // Clear-all control on the chip row.
  // Translators: Filter chip row: button that removes every filter (visible text and aria-label);
  // then two section headings in the Add filter popover.
  'pageBrowser.filter.clearAll': 'Clear all',
  'pageBrowser.filter.clearAllLabel': 'Clear all filters',
  'pageBrowser.filter.sharedGroup': 'Filters',
  'pageBrowser.filter.pagesGroup': 'Pages',

  // Translators: Add filter popover: the kinds of filter (menu items). Orphan = a page with no
  // links to or from it; Stub = a page with a title but no content. The last four are also the text
  // of their chip once added.
  'pageBrowser.filter.facetTag': 'Tag',
  'pageBrowser.filter.facetPath': 'Page path',
  'pageBrowser.filter.facetHasProperty': 'Has property',
  'pageBrowser.filter.facetPriority': 'Priority',
  'pageBrowser.filter.facetOrphan': 'Orphan',
  'pageBrowser.filter.facetStub': 'Stub',
  'pageBrowser.filter.facetHasNoInboundLinks': 'No inbound links',
  'pageBrowser.filter.facetExcludeJournalPages': 'Exclude journal pages',

  // Translators: Add filter popover, "Last edited" section: buttons for how recently a page was
  // edited; also the text of the chip once added.
  'pageBrowser.filter.lastEdited.today': 'Edited today',
  'pageBrowser.filter.lastEdited.thisWeek': 'Edited this week',
  'pageBrowser.filter.lastEdited.thisMonth': 'Edited this month',
  'pageBrowser.filter.lastEdited.older': 'Edited long ago',

  // Translators: Filter editors in the Add filter popover: Apply / Back buttons (Back returns to
  // the list of filters) and input placeholders. In "e.g. Projects/*", "Projects/*" is a sample
  // path pattern where * matches anything; the word may be translated, keep the "/*".
  'pageBrowser.filter.apply': 'Apply',
  'pageBrowser.filter.back': 'Back',
  'pageBrowser.filter.pathPlaceholder': 'e.g. Projects/*',
  'pageBrowser.filter.propertyKeyPlaceholder': 'Property key',
  'pageBrowser.filter.propertyValuePlaceholder': 'Value',

  // Property predicate op selector + path exclude toggle.
  // Translators: "Has property" filter editor: "Comparison" is the aria-label of the operator
  // dropdown; the options read as a sentence between a property name and a value, e.g.
  // "status is not done", so they start lowercase.
  'pageBrowser.filter.propertyOpLabel': 'Comparison',
  'pageBrowser.filter.propertyOpEq': 'is',
  'pageBrowser.filter.propertyOpNe': 'is not',
  // #4553 Phase 1 — the six comparison operators the advanced surface adds
  // on top of the Pages browser's classic Eq/Ne/Exists/NotExists (D24).
  'pageBrowser.filter.propertyOpLt': 'is less than',
  'pageBrowser.filter.propertyOpLte': 'is at most',
  'pageBrowser.filter.propertyOpGt': 'is greater than',
  'pageBrowser.filter.propertyOpGte': 'is at least',
  'pageBrowser.filter.propertyOpContains': 'contains',
  'pageBrowser.filter.propertyOpStartsWith': 'starts with',
  'pageBrowser.filter.propertyOpExists': 'exists',
  'pageBrowser.filter.propertyOpNotExists': "doesn't exist",

  // #4553 Phase 1 — the Ref-valued property picker's "you picked this page" readout.
  // Translators: "Has property" filter editor: {{title}} = the page picked as the value; then a
  // checkbox in the "Page path" editor that turns the filter into an exclusion.
  'pageBrowser.filter.propertyRefSelected': 'Selected: {{title}}',
  'pageBrowser.filter.pathExcludeLabel': 'Exclude matching pages',

  // Translators: Filter chip text: very short, lowercase. {{tag}} = a tag name; {{pattern}} = a
  // path pattern like "Projects/*"; {{key}} = a property name ("has:" / "no:" = the page has /
  // lacks that property). summaryProperty reads "<property> <operator> <value>", e.g.
  // "status = done"; reorder the placeholders if your language needs it.
  'pageBrowser.filter.summaryTag': 'tag: {{tag}}',
  'pageBrowser.filter.summaryPath': 'path: {{pattern}}',
  'pageBrowser.filter.summaryPathExclude': 'not path: {{pattern}}',
  'pageBrowser.filter.summaryHasProperty': 'has: {{key}}',
  'pageBrowser.filter.summaryNotHasProperty': 'no: {{key}}',
  'pageBrowser.filter.summaryProperty': '{{key}} {{op}} {{value}}',

  // #4553 Phase 1 — the `{{op}}` slot above. The six ordered/equality operators
  // render as their maths glyph (`= ≠ < ≤ > ≥`), which needs no catalog entry;
  // `Contains` / `StartsWith` are WORDS, so they get their own keys rather than
  // hardcoded English. SEPARATE from `propertyOpContains` / `propertyOpStartsWith`
  // above: those are the <select> option labels, which read as a sentence
  // fragment for the operator ("is less than"), whereas the chip is a compact
  // infix. Sharing one key would silently retitle the chip the day the option
  // label is reworded.
  // Translators: Inserted as {{op}} in pageBrowser.filter.summaryProperty, e.g.
  // "title contains plan"; other operators show as symbols like = ≠ < ≥.
  'pageBrowser.filter.summaryPropertyOpContains': 'contains',
  'pageBrowser.filter.summaryPropertyOpStartsWith': 'starts with',

  // Translators: More filter chip text: {{days}} = a number and "d" abbreviates days; {{start}} /
  // {{end}} = dates as YYYY-MM-DD; "this space" = the current space; {{priority}} = priority levels
  // like "1, 2"; summaryUnknown is the fallback text of a chip the app cannot describe.
  'pageBrowser.filter.summaryLastEditedRolling': 'edited ≤ {{days}}d',
  'pageBrowser.filter.summaryLastEditedRange': 'edited {{start}}…{{end}}',
  'pageBrowser.filter.summarySpace': 'this space',
  'pageBrowser.filter.summaryPriority': 'priority {{priority}}',
  'pageBrowser.filter.summaryUnknown': 'filter',

  // A11y: live-region announcements + facet descriptions
  // Translators: Screen-reader announcements when filters change, spoken after the action.
  // {{label}} = a chip's text like "tag: work"; the results count ({{count}}) is spoken right after
  // the added / removed message.
  'pageBrowser.filter.announceAdded': 'Filter added: {{label}}.',
  'pageBrowser.filter.announceRemoved': 'Filter removed: {{label}}.',
  'pageBrowser.filter.announceResults_one': '{{count}} result.',
  'pageBrowser.filter.announceResults_other': '{{count}} results.',
  // Clear-all of N chips announces a single dedicated
  // message (a per-chip `.find()` would announce only the first removed).
  'pageBrowser.filter.announceCleared': 'Cleared all filters.',

  // The backend rejects a malformed/disallowed compound
  // filter with an `InvalidFilter`-coded validation error; surface a specific
  // toast instead of the generic "Failed to load pages".
  // Translators: Error toast when a filter is rejected and not applied.
  'pageBrowser.filter.invalidFilter': 'That filter is invalid and was not applied.',

  // Tightened so Orphan and "No inbound links" read as clearly
  // distinct: Orphan is fully isolated (no links either way), whereas "No
  // inbound links" is the looser inbound-only sibling (the page may still link
  // out). Stub is about content, not links.
  // Translators: Add filter popover: one-line description under each kind of filter (Orphan / Stub
  // / No inbound links also show it as the chip's tooltip). Keep YYYY-MM-DD as is. "Last edited" is
  // a section heading in the popover.
  'pageBrowser.filter.facetOrphanDesc': 'Fully isolated — no inbound links and no outbound links.',
  'pageBrowser.filter.facetStubDesc': 'A titled page with no content blocks.',
  'pageBrowser.filter.facetHasNoInboundLinksDesc':
    'Nothing links to this page (it may still link out).',
  'pageBrowser.filter.facetExcludeJournalPagesDesc': 'Hide pages titled with a date (YYYY-MM-DD).',
  // Short descriptions for the value-bearing facets so they read
  // as clearly as the boolean ones in the Add-Filter popover.
  'pageBrowser.filter.facetTagDesc': 'Pages carrying the tag you pick.',
  'pageBrowser.filter.facetPathDesc': 'Pages whose path matches a glob pattern.',
  'pageBrowser.filter.facetHasPropertyDesc': 'Pages with a property matching a condition.',
  'pageBrowser.filter.facetLastEditedDesc': 'Pages edited within the chosen window.',
  'pageBrowser.filter.facetPriorityDesc': 'Pages set to a priority level.',
  'pageBrowser.filter.lastEditedGroup': 'Last edited',

  // #1280 D2 — advanced-query-only facet group: State / Block type / Due date /
  // Scheduled / Created. Gated to the Advanced Query surface (`showAdvancedFacets`).
  // Translators: Add filter popover, Advanced Query only: the "Advanced" section of filters and
  // their descriptions. State = a task state like TODO or DONE; a parent is the block a block is
  // nested under.
  'pageBrowser.filter.advancedGroup': 'Advanced',
  'pageBrowser.filter.facetState': 'State',
  'pageBrowser.filter.facetStateDesc': 'Blocks whose todo state matches.',
  'pageBrowser.filter.facetBlockType': 'Block type',
  'pageBrowser.filter.facetBlockTypeDesc': 'Blocks of the chosen type(s).',
  'pageBrowser.filter.facetDueDate': 'Due date',
  'pageBrowser.filter.facetDueDateDesc': 'Blocks whose due date matches.',
  'pageBrowser.filter.facetScheduled': 'Scheduled',
  'pageBrowser.filter.facetScheduledDesc': 'Blocks whose scheduled date matches.',
  'pageBrowser.filter.facetCreated': 'Created',
  'pageBrowser.filter.facetCreatedDesc': 'Blocks created in a date range.',
  // #1478 — relational facets (links-to / linked-from / has-parent-matching).
  'pageBrowser.filter.facetLinksTo': 'Links to',
  'pageBrowser.filter.facetLinksToDesc': 'Blocks with an outbound link to a page.',
  'pageBrowser.filter.facetLinkedFrom': 'Linked from',
  'pageBrowser.filter.facetLinkedFromDesc': 'Blocks with an inbound link from a page.',
  'pageBrowser.filter.facetHasParentMatching': 'Has parent matching',
  'pageBrowser.filter.facetHasParentMatchingDesc': 'Blocks whose parent satisfies a nested filter.',

  // Relational editor labels.
  // Translators: Advanced filter editors: headings of the page picker for "Links to" /
  // "Linked from", search placeholders and empty states of the page and tag pickers, and the
  // "Has parent matching" editor (label, hint, and the message shown while it has no condition).
  'pageBrowser.filter.linkTargetLabel': 'Target page',
  'pageBrowser.filter.linkSourceLabel': 'Source page',
  'pageBrowser.filter.linkPickPage': 'Pick a page…',
  'pageBrowser.filter.linkSearchPages': 'Search pages',
  'pageBrowser.filter.linkNoPages': 'No matching pages',
  'pageBrowser.filter.tagSearchPlaceholder': 'Search tags',
  'pageBrowser.filter.tagNoTags': 'No matching tags',
  'pageBrowser.filter.hasParentMatchingLabel': 'Parent matcher',
  'pageBrowser.filter.hasParentMatchingHint': 'Build the filter the parent block must satisfy.',
  'pageBrowser.filter.hasParentMatchingEmpty': 'Add at least one condition for the parent matcher.',

  // Relational chip summaries.
  // Translators: Filter chip text, lowercase: {{target}} / {{source}} = a page title; "(…)" stands
  // for a nested filter, keep it.
  'pageBrowser.filter.summaryLinksTo': 'links to {{target}}',
  'pageBrowser.filter.summaryLinkedFrom': 'linked from {{source}}',
  'pageBrowser.filter.summaryHasParentMatching': 'has parent matching (…)',

  // Editor field labels.
  // Translators: Advanced filter editors: the State editor (heading of the task-state checkboxes, a
  // checkbox for blocks with no state, a checkbox that inverts the filter) and the Block type
  // editor. Block types: Content = an ordinary text block, Page, Tag, Todo = a task; also used as
  // group headings in Advanced Query results.
  'pageBrowser.filter.stateValuesLabel': 'States',
  'pageBrowser.filter.stateIsNullLabel': 'No state (unset)',
  'pageBrowser.filter.excludeLabel': 'Exclude matching blocks',
  'pageBrowser.filter.blockTypeValuesLabel': 'Block types',
  'pageBrowser.filter.blockType.content': 'Content',
  'pageBrowser.filter.blockType.page': 'Page',
  'pageBrowser.filter.blockType.tag': 'Tag',
  'pageBrowser.filter.blockType.todo': 'Todo',

  // Date predicate operator labels.
  // Translators: Due date / Scheduled / Created filter editors: "Condition" is the aria-label of
  // the operator dropdown, whose options are read after the filter name, e.g.
  // "Due date before <date>", so they start lowercase; then the labels of the date fields.
  'pageBrowser.filter.dateOpLabel': 'Condition',
  'pageBrowser.filter.dateOpIsNull': 'is unset',
  'pageBrowser.filter.dateOpBefore': 'before',
  'pageBrowser.filter.dateOpAfter': 'after',
  'pageBrowser.filter.dateOpOnOrBefore': 'on or before',
  'pageBrowser.filter.dateOpOnOrAfter': 'on or after',
  'pageBrowser.filter.dateOpOn': 'on',
  'pageBrowser.filter.dateOpBetween': 'between',
  'pageBrowser.filter.dateLabel': 'Date',
  'pageBrowser.filter.dateFromLabel': 'From date',
  'pageBrowser.filter.dateToLabel': 'To date',
  'pageBrowser.filter.createdAfterLabel': 'Created after',
  'pageBrowser.filter.createdBeforeLabel': 'Created before',

  // Chip summaries for the advanced facets.
  // Translators: Filter chip text, lowercase. {{values}} = a comma-separated list: task states like
  // "TODO, DOING" or block types like "content, page"; "none" is added to the state list for blocks
  // with no state. The due / scheduled words are inserted as {{prefix}} in the strings below.
  'pageBrowser.filter.summaryState': 'state: {{values}}',
  'pageBrowser.filter.summaryStateExclude': 'state not: {{values}}',
  'pageBrowser.filter.summaryStateNone': 'none',
  'pageBrowser.filter.summaryBlockType': 'type: {{values}}',
  'pageBrowser.filter.summaryBlockTypeExclude': 'type not: {{values}}',
  'pageBrowser.filter.summaryDuePrefix': 'due',
  'pageBrowser.filter.summaryScheduledPrefix': 'scheduled',

  // Translators: Date filter chip text. {{prefix}} = "due" or "scheduled" (the two words above);
  // {{date}}, {{from}}, {{to}} = dates as YYYY-MM-DD. Keep the symbols < > ≤ ≥ = and the "…" range.
  'pageBrowser.filter.summaryDateIsNull': '{{prefix}} unset',
  'pageBrowser.filter.summaryDateBefore': '{{prefix}} < {{date}}',
  'pageBrowser.filter.summaryDateAfter': '{{prefix}} > {{date}}',
  'pageBrowser.filter.summaryDateOnOrBefore': '{{prefix}} ≤ {{date}}',
  'pageBrowser.filter.summaryDateOnOrAfter': '{{prefix}} ≥ {{date}}',
  'pageBrowser.filter.summaryDateOn': '{{prefix}} = {{date}}',
  'pageBrowser.filter.summaryDateBetween': '{{prefix}} {{from}}…{{to}}',

  // Translators: Created filter chip text, lowercase. {{date}}, {{after}}, {{before}} = dates as
  // YYYY-MM-DD; "…" marks the range.
  'pageBrowser.filter.summaryCreatedAfter': 'created after {{date}}',
  'pageBrowser.filter.summaryCreatedBefore': 'created before {{date}}',
  'pageBrowser.filter.summaryCreatedBetween': 'created {{after}}…{{before}}',
}
