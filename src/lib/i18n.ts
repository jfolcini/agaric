/**
 * i18n configuration — internationalization framework.
 *
 * Usage in components:
 *   import { useTranslation } from 'react-i18next'
 *   const { t } = useTranslation()
 *   <p>{t('empty.noBlocks')}</p>
 *
 * To add a new language: add a new key under `resources` (e.g., `es: { translation: { ... } }`).
 * To extract more strings: replace hardcoded text with t('key') calls.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const resources = {
  en: {
    translation: {
      // Sidebar
      'sidebar.pages': 'Pages',
      'sidebar.journal': 'Journal',
      'sidebar.newPage': 'New Page',
      'sidebar.sync': 'Sync',
      'sidebar.shortcuts': 'Shortcuts',
      'sidebar.search': 'Search',
      'sidebar.tags': 'Tags',
      'sidebar.trash': 'Trash',
      'sidebar.status': 'Status',
      'sidebar.conflicts': 'Conflicts',
      'sidebar.history': 'History',
      'sidebar.templates': 'Templates',
      'sidebar.collapse': 'Collapse',
      'sidebar.toggleSidebar': 'Toggle Sidebar',
      'sidebar.newPageTooltip': 'New Page (Ctrl+N)',
      'sidebar.offline': 'Offline',
      'sidebar.syncTooltip': 'Sync all devices',
      'sidebar.syncing': 'Syncing...',

      // Empty states
      'empty.noBlocks': 'No blocks yet. Click + Add block below to start writing.',
      'empty.noPages': 'No pages yet. Create one to get started.',

      // Actions
      'action.addBlock': 'Add block',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.delete': 'Delete',
      'action.undo': 'Undo',
      'action.redo': 'Redo',
      'action.retry': 'Retry',
      'action.loadMore': 'Load more',
      'action.loading': 'Loading\u2026',

      // Journal
      'journal.today': 'Today',
      'journal.daily': 'Daily',
      'journal.weekly': 'Weekly',
      'journal.monthly': 'Monthly',
      'journal.agenda': 'Agenda',
      'journal.tasks': 'Tasks',
      'journal.dayTab': 'Day',
      'journal.weekTab': 'Week',
      'journal.monthTab': 'Month',
      'journal.agendaTab': 'Agenda',
      'journal.dailyView': 'Daily view',
      'journal.weeklyView': 'Weekly view',
      'journal.monthlyView': 'Monthly view',
      'journal.agendaView': 'Agenda view',
      'journal.noBlocks': 'No blocks for {{date}}.',
      'journal.addFirstBlock': 'Add your first block',
      'journal.openInEditor': 'Open in page editor',
      'journal.dueBadge': 'due',
      'journal.refsBadge': 'refs',
      'journal.addBlockFailed': 'Failed to add block',
      'journal.prevDay': 'Previous day',
      'journal.prevWeek': 'Previous week',
      'journal.prevMonth': 'Previous month',
      'journal.nextDay': 'Next day',
      'journal.nextWeek': 'Next week',
      'journal.nextMonth': 'Next month',
      'journal.goToToday': 'Go to today',
      'journal.openCalendar': 'Open calendar picker',
      'journal.monthlyCalendarLabel': 'Monthly calendar',
      'journal.loadCountsFailed': 'Failed to load calendar counts',
      'journal.loadCalendarFailed': 'Failed to load calendar',

      // Formatting toolbar
      'toolbar.bold': 'Bold',
      'toolbar.italic': 'Italic',
      'toolbar.code': 'Code',
      'toolbar.strikethrough': 'Strikethrough',
      'toolbar.highlight': 'Highlight',
      'toolbar.link': 'External link',
      'toolbar.pageLink': 'Page link',
      'toolbar.tag': 'Tag',
      'toolbar.codeBlock': 'Code block',
      'toolbar.insertDate': 'Insert date',
      'toolbar.dueDate': 'Due date',
      'toolbar.todoToggle': 'Toggle TODO state',
      'toolbar.heading': 'Heading',
      'toolbar.discard': 'Discard changes',
      'toolbar.formatting': 'Formatting',
      'toolbar.internalLink': 'Internal link',
      'toolbar.insertTag': 'Insert tag',
      'toolbar.headingLevel': 'Heading level',
      'toolbar.priority1': 'Priority 1 (high)',
      'toolbar.priority2': 'Priority 2 (medium)',
      'toolbar.priority3': 'Priority 3 (low)',
      'toolbar.cyclePriority': 'Cycle priority',
      'toolbar.setDueDate': 'Set due date',
      'toolbar.setScheduledDate': 'Set scheduled date',
      'toolbar.undo': 'Undo',
      'toolbar.redo': 'Redo',
      'toolbar.paragraph': 'Paragraph',

      // Formatting toolbar — tooltips
      'toolbar.boldTip': 'Bold (Ctrl+B)',
      'toolbar.italicTip': 'Italic (Ctrl+I)',
      'toolbar.codeTip': 'Inline code (Ctrl+E)',
      'toolbar.strikethroughTip': 'Strikethrough (Ctrl+Shift+X)',
      'toolbar.highlightTip': 'Highlight (Ctrl+Shift+H)',
      'toolbar.linkTip': 'External link (Ctrl+K)',
      'toolbar.pageLinkTip': 'Page link ([[)',
      'toolbar.tagTip': 'Tag (@)',
      'toolbar.codeBlockTip': 'Code block (Ctrl+Shift+C)',
      'toolbar.blockquote': 'Blockquote',
      'toolbar.blockquoteTip': 'Blockquote (Ctrl+Shift+B)',
      'toolbar.headingTip': 'Heading (Ctrl+1-6)',
      'toolbar.priority1Tip': 'Priority 1 — high (Ctrl+Shift+1)',
      'toolbar.priority2Tip': 'Priority 2 — medium (Ctrl+Shift+2)',
      'toolbar.priority3Tip': 'Priority 3 — low (Ctrl+Shift+3)',
      'toolbar.cyclePriorityTip': 'Cycle priority (Ctrl+Shift+1)',
      'toolbar.insertDateTip': 'Insert date (Ctrl+Shift+D)',
      'toolbar.dueDateTip': 'Due date (/due)',
      'toolbar.scheduledDateTip': 'Scheduled date (/schedule)',
      'toolbar.todoToggleTip': 'TODO cycle (Ctrl+Enter)',
      'toolbar.properties': 'Properties',
      'toolbar.propertiesTip': 'Block properties (Ctrl+Shift+P)',
      'toolbar.undoTip': 'Undo (Ctrl+Z)',
      'toolbar.redoTip': 'Redo (Ctrl+Y)',
      'toolbar.discardTip': 'Discard changes (Esc)',
      'toolbar.orderedList': 'Ordered list',
      'toolbar.orderedListTip': 'Ordered list (1. prefix)',
      'toolbar.divider': 'Divider',
      'toolbar.dividerTip': 'Divider (---)',
      'toolbar.callout': 'Callout',
      'toolbar.calloutTip': 'Callout (> [!INFO])',

      // Context menu
      'contextMenu.delete': 'Delete',
      'contextMenu.indent': 'Indent',
      'contextMenu.dedent': 'Dedent',
      'contextMenu.moveUp': 'Move Up',
      'contextMenu.moveDown': 'Move Down',
      'contextMenu.merge': 'Merge with previous',
      'contextMenu.collapse': 'Collapse',
      'contextMenu.expand': 'Expand',
      'contextMenu.history': 'History',
      'contextMenu.noActions': 'No actions available',
      'contextMenu.blockActions': 'Block actions',
      'contextMenu.todoToDoing': 'TODO → DOING',
      'contextMenu.doingToDone': 'DOING → DONE',
      'contextMenu.doneToClear': 'DONE → Clear',
      'contextMenu.setTodo': 'Set as TODO',
      'contextMenu.priority1To2': 'Priority 1 → 2',
      'contextMenu.priority2To3': 'Priority 2 → 3',
      'contextMenu.priority3ToClear': 'Priority 3 → Clear',
      'contextMenu.setPriority1': 'Set priority 1',
      'contextMenu.properties': 'Properties...',
      'contextMenu.zoomIn': 'Zoom in',

      // Block
      'block.reorder': 'Reorder block (drag or use keyboard)',
      'block.reorderTip': 'Reorder (drag or keyboard)',
      'block.delete': 'Delete block',
      'block.history': 'Block history',
      'block.collapseChildren': 'Collapse children',
      'block.expandChildren': 'Expand children',
      'block.collapseTip': 'Collapse (Ctrl+.)',
      'block.expandTip': 'Expand (Ctrl+.)',
      'block.setTodo': 'Set as TODO',
      'block.taskCycle': 'Task: {{state}}. Click to cycle.',
      'block.setTodoTip': 'Set as TODO (Ctrl+Enter)',
      'block.todoCycleTip': '{{state}} (Ctrl+Enter to cycle)',
      'block.priorityCycle': 'Priority {{level}}. Click to cycle.',
      'block.priorityTip': 'Priority {{level}} (click to cycle)',
      'block.dueDate': 'Due {{date}}',
      'block.scheduledDate': 'Scheduled {{date}}',
      'block.repeats': 'Repeats {{value}}',
      'block.breadcrumb': 'Block breadcrumb',
      'block.zoomToRoot': 'Go to root',
      'block.untitled': 'Untitled',
      'block.searchPages': 'Search pages...',
      'block.noPagesFound': 'No pages found',
      'block.refPickerLabel': 'Select a page',
      'block.editProperty': 'Edit property',

      // Block references
      'blockRef.pickerLabel': 'Block references',
      'blockRef.fallback': '(( {{id}}... ))',

      // Attachments
      'attachments.loading': 'Loading attachments…',
      'attachments.empty': 'No attachments yet.',
      'attachments.list': 'Attachments',
      'attachments.delete': 'Delete attachment {{name}}',
      'attachments.deleted': 'Deleted {{name}}',
      'attachments.confirmDelete': 'Delete "{{name}}"?',
      'attachments.clickAgain': 'Click the delete button again to confirm.',
      'block.attachments': '{{count}} attachment(s)',
      'block.attachmentsTip': '{{count}} attachment(s) — click to toggle',

      // Errors
      'error.generic': 'Something went wrong',
      'error.loadFailed': 'Failed to load data',
      'error.saveFailed': 'Failed to save',
      'error.createBlockFailed': 'Failed to create block',
      'error.sectionCrashed': '{{section}} encountered an error',
      'error.unexpected': 'An unexpected error occurred',

      // Slash commands
      'slash.repeatSet': 'Set repeat to {{value}}',
      'slash.repeatFailed': 'Failed to set repeat',
      'slash.effortSet': 'Set effort to {{value}}',
      'slash.effortFailed': 'Failed to set effort',
      'slash.noTemplates':
        'No templates found. To create one: make a page, open its properties (click the page title area), and add a "template" property set to "true".',
      'slash.templateLoadFailed': 'Failed to load templates',
      'slash.templateInserted': 'Template inserted',
      'slash.templateInsertFailed': 'Failed to insert template',
      'slash.templatePicker': 'Select template',
      'slash.selectTemplate': 'Select a template',

      // Slash commands — callouts
      'slash.calloutFailed': 'Failed to insert callout',

      // Slash commands — ordered list & divider
      'slash.numberedListFailed': 'Failed to insert numbered list',
      'slash.dividerFailed': 'Failed to insert divider',

      // Callout labels
      'callout.info': 'Info',
      'callout.warning': 'Warning',
      'callout.tip': 'Tip',
      'callout.error': 'Error',
      'callout.note': 'Note',

      // Slash command category labels (UX-50)
      'slashCommand.categories.tasks': 'Tasks',
      'slashCommand.categories.dates': 'Dates',
      'slashCommand.categories.references': 'References',
      'slashCommand.categories.structure': 'Structure',
      'slashCommand.categories.properties': 'Properties',
      'slashCommand.categories.templates': 'Templates',
      'slashCommand.categories.queries': 'Queries',
      'slashCommand.categories.repeat': 'Repeat',

      // Linked References
      'references.headerOne': '1 Reference',
      'references.header': '{{count}} References',
      'references.loadMore': 'Load more',
      'references.loading': 'Loading...',
      'references.loadFailed': 'Failed to load references',
      'references.untitled': 'Untitled',
      'references.empty': '(empty)',
      'references.hideFilters': 'Hide filters',
      'references.moreFilters': 'More filters',
      'references.loadingMore': 'Loading more references',
      'references.loadMoreLabel': 'Load more references',
      'references.backlinksFrom': 'Backlinks from {{title}}',

      // Unlinked References
      'unlinkedRefs.headerNone': 'No Unlinked References',
      'unlinkedRefs.headerOne': '1 Unlinked Reference',
      'unlinkedRefs.header': '{{count}} Unlinked References',
      'unlinkedRefs.linkIt': 'Link it',
      'unlinkedRefs.loadMore': 'Load more',
      'unlinkedRefs.loading': 'Loading\u2026',
      'unlinkedRefs.loadingDots': 'Loading...',
      'unlinkedRefs.loadFailed': 'Failed to load unlinked references',
      'unlinkedRefs.linkFailed': 'Failed to link reference',
      'unlinkedRefs.noResults': 'No unlinked references found.',
      'unlinkedRefs.untitled': 'Untitled',
      'unlinkedRefs.empty': '(empty)',
      'unlinkedRefs.loadingMore': 'Loading more unlinked references',
      'unlinkedRefs.loadMoreLabel': 'Load more unlinked references',
      'unlinkedRefs.mentionsFrom': 'Unlinked mentions from {{title}}',

      // Done Panel
      'donePanel.headerOne': '1 Completed',
      'donePanel.header': '{{count}} Completed',
      'donePanel.loading': 'Loading...',
      'donePanel.loadMore': 'Load more',
      'donePanel.breadcrumbArrow': '\u2192',
      'donePanel.untitled': 'Untitled',
      'donePanel.completedItems': 'Completed items',
      'donePanel.loadingMore': 'Loading more completed items',
      'donePanel.loadMoreLabel': 'Load more completed items',
      'donePanel.groupItemsLabel': '{{title}} completed items',

      // Agenda
      'agenda.loadingTasks': 'Loading tasks...',
      'agenda.noTasks':
        'No dated tasks found. Add a due date or scheduled date to your tasks to see them here.',
      'agenda.noMatch': 'No blocks match your filters.',
      'agenda.clearFilters': 'Clear all filters',
      'agenda.zeroResults': '0 results',
      'agenda.resultOne': '1 result',
      'agenda.resultCount': '{{count}} results',
      'agenda.loadMore': 'Load more',
      'agenda.loading': 'Loading...',
      'agenda.untitled': 'Untitled',
      'agenda.loadingMore': 'Loading more tasks',
      'agenda.loadMoreLabel': 'Load more tasks',
      'agenda.agendaResults': 'Agenda results',
      'agenda.overdue': 'Overdue',
      'agenda.today': 'Today',
      'agenda.tomorrow': 'Tomorrow',
      'agenda.noDate': 'No date',
      'agenda.sortBy': 'Sort by',
      'agenda.groupBy': 'Group by',
      'agenda.sortDate': 'Date',
      'agenda.sortPriority': 'Priority',
      'agenda.sortState': 'State',
      'agenda.groupDate': 'Date',
      'agenda.groupPriority': 'Priority',
      'agenda.groupState': 'State',
      'agenda.groupNone': 'None',
      'agenda.breadcrumbArrow': '\u2192',

      // Task dependencies (F-37)
      'dependency.blockedBy': 'Blocked by: {{title}}',
      'dependency.blockedByUnresolved': 'Blocked by another task',
      'dependency.dependencyWarning': 'This task has dependencies that may not be complete',

      // Date Chip Editor (F-22)
      'dateChip.editDate': 'Edit date',
      'dateChip.placeholder': 'today, +3d, Apr 15',
      'dateChip.inputLabel': 'Type a date',
      'dateChip.today': 'Today',
      'dateChip.tomorrow': 'Tomorrow',
      'dateChip.nextWeek': 'Next Week',
      'dateChip.clear': 'Clear',
      'dateChip.dateUpdated': 'Date updated',
      'dateChip.dateCleared': 'Date cleared',
      'dateChip.updateFailed': 'Failed to update date',

      // Agenda Filter
      'agendaFilter.status': 'Status',
      'agendaFilter.priority': 'Priority',
      'agendaFilter.dueDate': 'Due date',
      'agendaFilter.scheduledDate': 'Scheduled date',
      'agendaFilter.completedDate': 'Completed date',
      'agendaFilter.createdDate': 'Created date',
      'agendaFilter.tag': 'Tag',
      'agendaFilter.property': 'Property',
      'agendaFilter.propertyKey': 'Property key',
      'agendaFilter.propertyValue': 'Value (optional)',
      'agendaFilter.propertyValuePlaceholder': 'Filter value...',
      'agendaFilter.selectProperty': 'Select property...',
      'agendaFilter.tagPlaceholder': 'Search tags...',
      'agendaFilter.tagName': 'Tag name',
      'agendaFilter.tagSearchResults': 'Matching tags',
      'agendaFilter.addFilter': 'Add filter',
      'agendaFilter.apply': 'Apply',
      'agendaFilter.applyFilter': 'Apply filter',
      'agendaFilter.removeFilter': 'Remove filter',
      'agendaFilter.combinedWithAnd': 'Filters combined with AND',
      'agendaFilter.filterAppliedOne': '1 filter applied',
      'agendaFilter.filtersApplied': '{{count}} filters applied',
      'agendaFilter.filterDimensions': 'Filter dimensions',
      'agendaFilter.agendaFilters': 'Agenda filters',
      'agendaFilter.appliedFilters': 'Applied filters',
      'agendaFilter.optionsLabel': '{{label}} options',
      'agendaFilter.editFilter': 'Edit {{label}} filter',
      'agendaFilter.removeFilterLabel': 'Remove {{label}} filter',

      // History
      'history.title': 'Block History',

      // Page Header
      'pageHeader.pageTitle': 'Page title',
      'pageHeader.goBack': 'Go back',
      'pageHeader.undoAction': 'Undo last page action',
      'pageHeader.redoAction': 'Redo last page action',
      'pageHeader.undone': 'Undone',
      'pageHeader.undoFailed': 'Undo failed',
      'pageHeader.redone': 'Redone',
      'pageHeader.redoFailed': 'Redo failed',
      'pageHeader.renameFailed': 'Failed to rename page',
      'pageHeader.aliases': 'Also known as:',
      'pageHeader.aliasUpdateFailed': 'Failed to update aliases',
      'pageHeader.newAliasPlaceholder': 'New alias...',
      'pageHeader.newAliasInput': 'New alias input',
      'pageHeader.addAlias': '+ Add alias',
      'pageHeader.add': 'Add',
      'pageHeader.done': 'Done',
      'pageHeader.edit': 'Edit',
      'pageHeader.removeAlias': 'Remove alias {{alias}}',
      'pageHeader.addTag': 'Add tag',
      'pageHeader.removeTag': 'Remove tag {{name}}',
      'pageHeader.searchTags': 'Search or create tag...',
      'pageHeader.searchTagsLabel': 'Search tags',
      'pageHeader.tagPicker': 'Tag picker',
      'pageHeader.createTag': 'Create "{{name}}"',
      'pageHeader.noMoreTags': 'No more tags',
      'pageHeader.pageActions': 'Page actions',
      'pageHeader.saveAsTemplate': 'Save as template',
      'pageHeader.removeTemplate': 'Remove template status',
      'pageHeader.setJournalTemplate': 'Set as journal template',
      'pageHeader.removeJournalTemplate': 'Remove journal template',
      'pageHeader.menuAddAlias': 'Add alias',
      'pageHeader.menuAddTag': 'Add tag',
      'pageHeader.menuAddProperty': 'Add property',

      // Templates view (F-25)
      'templates.empty': 'No templates yet. Mark a page as a template to see it here.',
      'templates.search': 'Search templates…',
      'templates.journalIndicator': 'Journal template',
      'templates.navigateLabel': 'Open template {{name}}',
      'templates.removeTemplateLabel': 'Remove template status from {{name}}',
      'templates.noResults': 'No templates match your search.',

      'pageHeader.exportMarkdown': 'Export as Markdown',
      'pageHeader.deletePage': 'Delete page',
      'pageHeader.deletePageTitle': 'Delete page',
      'pageHeader.deletePageDescription':
        'This action cannot be undone. This will permanently delete the page and all its blocks.',
      'pageHeader.cancel': 'Cancel',
      'pageHeader.templateSaved': 'Saved as template',
      'pageHeader.templateRemoved': 'Template status removed',
      'pageHeader.templateFailed': 'Failed to update template status',
      'pageHeader.journalTemplateSaved': 'Set as journal template',
      'pageHeader.journalTemplateRemoved': 'Journal template removed',
      'pageHeader.journalTemplateFailed': 'Failed to update journal template',
      'pageHeader.exportCopied': 'Markdown copied to clipboard',
      'pageHeader.exportFailed': 'Export failed',
      'pageHeader.pageDeleted': 'Page deleted',
      'pageHeader.deleteFailed': 'Failed to delete page',
      'pageHeader.deleteConfirm': 'Delete this page? It can be restored from trash.',

      // Page Browser
      'pageBrowser.newPagePlaceholder': 'New page name...',
      'pageBrowser.newPage': 'New Page',
      'pageBrowser.noPages': 'No pages yet.',
      'pageBrowser.createFirst': 'Create your first page',
      'pageBrowser.untitled': 'Untitled',
      'pageBrowser.loadMore': 'Load more',
      'pageBrowser.loading': 'Loading...',
      'pageBrowser.deletePage': 'Delete page?',
      'pageBrowser.deleteDescription':
        'This will permanently delete the page \u201c{{name}}\u201d and all its child blocks. This action cannot be undone.',
      'pageBrowser.deleteSuccess': 'Page deleted',
      'pageBrowser.deleteCascadeWarning':
        'This will permanently delete the page and all its blocks.',
      'pageBrowser.delete': 'Delete',
      'pageBrowser.cancel': 'Cancel',
      'pageBrowser.deleteButton': 'Delete page',
      'pageBrowser.loadFailed': 'Failed to load pages',
      'pageBrowser.createFailed': 'Failed to create page: {{error}}',
      'pageBrowser.deleteFailed': 'Failed to delete page: {{error}}',
      'pageBrowser.retry': 'Retry',
      'pageBrowser.exportAll': 'Export all pages',
      'pageBrowser.exporting': 'Exporting...',
      'pageBrowser.exportSuccess': 'Pages exported as ZIP',
      'pageBrowser.exportFailed': 'Failed to export pages',
      'pageBrowser.searchPlaceholder': 'Search pages...',
      'pageBrowser.noMatches': 'No matching pages',
      'pageBrowser.sortLabel': 'Sort order',
      'pageBrowser.sortRecent': 'Recent',
      'pageBrowser.sortAlphabetical': 'Alphabetical',
      'pageBrowser.sortCreated': 'Created',
      'pageBrowser.starPage': 'Star page',
      'pageBrowser.unstarPage': 'Unstar page',
      'pageBrowser.showStarred': 'Show starred pages',
      'pageBrowser.showAll': 'Show all pages',
      'pageBrowser.noStarredPages': 'No starred pages',

      // Due Panel
      'duePanel.headerOne': '1 Due',
      'duePanel.header': '{{count}} Due',
      'duePanel.groupDoing': 'DOING',
      'duePanel.groupTodo': 'TODO',
      'duePanel.groupDone': 'DONE',
      'duePanel.groupOther': 'Other',
      'duePanel.loadMore': 'Load more',
      'duePanel.loading': 'Loading...',
      'duePanel.loadingMore': 'Loading more due items',
      'duePanel.loadMoreLabel': 'Load more due items',
      'duePanel.breadcrumbArrow': '\u2192',
      'duePanel.untitled': 'Untitled',
      'duePanel.empty': 'Nothing due — enjoy your day!',
      'duePanel.filterAll': 'All',
      'duePanel.filterDue': 'Due',
      'duePanel.filterScheduled': 'Scheduled',
      'duePanel.filterProperties': 'Properties',

      // Query
      'query.noResults': 'No results',

      // Search
      'search.minCharsHint': 'Search requires at least 3 characters',
      'search.parentPage': 'in: {{title}}',

      // Editor
      'editor.templatePlaceholder':
        'Type /template to start from a template, or just start typing...',

      // Property table
      'property.drawerTitle': 'Block Properties',
      'property.loading': 'Loading...',
      'property.noProperties': 'No properties set',
      'property.loadFailed': 'Failed to load properties',
      'property.saveFailed': 'Failed to save property',
      'property.deleteFailed': 'Failed to delete property',
      'property.delete': 'Delete property',
      'property.addProperty': 'Add property',
      'property.invalidNumber': 'Invalid number value',
      'property.deleteConfirm': 'Delete this property?',
      'property.deleteConfirmDesc': 'This will remove the property from the block.',
      'property.createDefFailed': 'Failed to create property definition',
      'property.dueDate': 'Due',
      'property.scheduledDate': 'Scheduled',
      'property.createdAt': 'Created At',
      'property.completedAt': 'Completed At',
      'property.effort': 'Effort',
      'property.assignee': 'Assignee',
      'property.location': 'Location',
      'property.repeat': 'Repeat',
      'property.repeatUntil': 'Repeat Until',
      'property.repeatCount': 'Repeat Count',
      'property.repeatSeq': 'Repeat Seq',
      'property.repeatOrigin': 'Repeat Origin',
      'property.todoState': 'Todo State',
      'property.priority': 'Priority',
      'property.clearDueDate': 'Clear due date',
      'property.clearScheduledDate': 'Clear scheduled date',
      'property.valueLabel': '{{key}} value',
      'property.selectProperty': 'Select property...',

      // Properties view
      'sidebar.properties': 'Properties',
      'propertiesView.title': 'Property Definitions',
      'propertiesView.search': 'Search properties...',
      'propertiesView.empty': 'No property definitions yet',
      'propertiesView.createKey': 'Property key',
      'propertiesView.createType': 'Type',
      'propertiesView.create': 'Create',
      'propertiesView.deleteConfirm': 'Delete this property definition?',
      'propertiesView.deleteDesc':
        'Blocks using this property will keep their values, but the definition will be removed.',
      'propertiesView.deleted': 'Property definition deleted',
      'propertiesView.created': 'Property definition created',
      'propertiesView.editOptions': 'Edit options',
      'propertiesView.taskStates': 'Task States',
      'propertiesView.taskStatesDesc':
        'Customize the task state cycle. Click a block checkbox to cycle through these states.',
      'propertiesView.addTaskState': 'New state (e.g., CANCELLED)',
      'propertiesView.add': 'Add',
      'propertiesView.taskStatesReload': 'Reload the page to apply changes.',
      'propertiesView.duplicateKey': 'A property with this key already exists',
      'propertiesView.deadlineWarning': 'Deadline Warning',
      'propertiesView.deadlineWarningDesc':
        'Show tasks approaching their deadline in the DuePanel. Set to 0 to disable.',

      // Tags
      'tags.loadFailed': 'Failed to load tags',
      'tags.nameTooLong': 'Tag name must be under 100 characters',
      'tags.deleteWarning': 'Blocks using this tag will lose the reference.',
      'tags.duplicateName': 'A tag with that name already exists.',
      'tags.renameSuccess': 'Tag renamed successfully.',
      'tags.renameFailed': 'Failed to rename tag',
      'tags.renameTitle': 'Rename tag',
      'tags.renameDescription': 'Enter a new name for this tag.',
      'tags.renamePlaceholder': 'Tag name',
      'tagList.empty': 'No tags yet. Create one above to organize your blocks.',

      // Shortcuts / Quick Reference
      'shortcuts.title': 'Quick Reference',
      'shortcuts.syntaxSection': 'Syntax',

      // Keyboard shortcuts — sheet UI
      'keyboard.sheetDescription':
        'Available keyboard shortcuts and syntax reference for the editor.',
      'keyboard.shortcutHeader': 'Shortcut',
      'keyboard.actionHeader': 'Action',
      'keyboard.descriptionHeader': 'Description',

      // Keyboard shortcuts — categories
      'keyboard.category.navigation': 'Navigation',
      'keyboard.category.editing': 'Editing',
      'keyboard.category.pickers': 'Pickers',
      'keyboard.category.journal': 'Journal',
      'keyboard.category.blockSelection': 'Block Selection',
      'keyboard.category.undoRedo': 'Undo / Redo',
      'keyboard.category.historyView': 'History View',
      'keyboard.category.global': 'Global',

      // Keyboard shortcuts — conditions
      'keyboard.condition.atStart': 'at start',
      'keyboard.condition.atEnd': 'at end',
      'keyboard.condition.onEmptyBlock': 'on empty block',
      'keyboard.condition.atStartOfBlock': 'at start of block',
      'keyboard.condition.inEditor': 'in editor',
      'keyboard.condition.notEditing': 'not editing',
      'keyboard.condition.withSelection': 'with selection',
      'keyboard.condition.outsideEditor': 'outside editor',

      // Keyboard shortcuts — navigation descriptions
      'keyboard.moveToPreviousBlock': 'Move to previous block',
      'keyboard.moveToNextBlock': 'Move to next block',

      // Keyboard shortcuts — editing descriptions
      'keyboard.saveBlockAndClose': 'Save block and close editor',
      'keyboard.deleteBlock': 'Delete block',
      'keyboard.mergeWithPrevious': 'Merge with previous',
      'keyboard.indentBlock': 'Indent block',
      'keyboard.dedentBlock': 'Dedent block',
      'keyboard.cycleTaskState': 'Cycle task state (TODO → DOING → DONE → none)',
      'keyboard.collapseExpandChildren': 'Collapse / expand children',
      'keyboard.insertOrEditLink': 'Insert or edit external link',
      'keyboard.toggleCodeBlock': 'Toggle code block',
      'keyboard.toggleStrikethrough': 'Toggle strikethrough',
      'keyboard.toggleHighlight': 'Toggle highlight',
      'keyboard.moveBlockUp': 'Move block up',
      'keyboard.moveBlockDown': 'Move block down',
      'keyboard.insertLineBreak': 'Insert line break (soft return)',

      // Keyboard shortcuts — pickers descriptions
      'keyboard.tagPicker': 'Tag picker',
      'keyboard.blockLinkPicker': 'Block link picker',
      'keyboard.slashCommandMenu': 'Slash command menu',

      // Keyboard shortcuts — journal descriptions
      'keyboard.previousDayWeekMonth': 'Previous day / week / month',
      'keyboard.nextDayWeekMonth': 'Next day / week / month',
      'keyboard.goToToday': 'Go to today',

      // Keyboard shortcuts — block selection descriptions
      'keyboard.toggleBlockSelection': 'Toggle block selection',
      'keyboard.rangeSelectBlocks': 'Range select blocks',
      'keyboard.selectAllBlocks': 'Select all blocks',
      'keyboard.clearSelection': 'Clear selection',

      // Keyboard shortcuts — undo/redo descriptions
      'keyboard.undoLastPageOp': 'Undo last page operation',
      'keyboard.redoLastUndoneOp': 'Redo last undone operation',

      // Keyboard shortcuts — history view descriptions
      'keyboard.toggleSelection': 'Toggle selection',
      'keyboard.rangeSelect': 'Range select',
      'keyboard.selectAll': 'Select all',
      'keyboard.revertSelected': 'Revert selected',
      'keyboard.navigateItems': 'Navigate items',
      'keyboard.navigateItemsVim': 'Navigate items (vim-style)',

      // Keyboard shortcuts — global descriptions
      'keyboard.focusSearch': 'Focus search',
      'keyboard.toggleSidebar': 'Toggle sidebar',
      'keyboard.createNewPage': 'Create new page',
      'keyboard.showKeyboardShortcuts': 'Show keyboard shortcuts',
      'keyboard.closeOverlays': 'Close overlays, cancel editing, clear selection',

      // Keyboard shortcuts — syntax descriptions
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
      'keyboard.syntax.slashCommand': 'Slash command menu',

      // Conflict type tooltips
      'conflict.typeText': 'Text conflict — content edited on multiple devices',
      'conflict.typeProperty': 'Property conflict — property changed on multiple devices',
      'conflict.typeMove': 'Move conflict — block moved to different locations',
      'conflict.expand': 'Expand conflict details',
      'conflict.collapse': 'Collapse conflict details',

      // Peer address (manual IP entry)
      'status.peerAddress': 'Address',
      'status.peerAddressNotSet': 'No address',
      'status.editAddress': 'Edit',
      'status.addressUpdated': 'Address updated',
      'status.addressInvalid': 'Invalid address format (expected host:port)',
      'status.manualIpHint':
        'If mDNS discovery is unavailable, share this device\u2019s IP and sync port with the remote peer, then set it via the address edit button below.',

      // Import
      'status.importTitle': 'Import',
      'status.importDesc':
        'Import Logseq or Markdown files. Pages are created from filenames, blocks from indented list items.',
      'status.importButton': 'Select .md files',

      // Backlink filter
      'backlink.searchTextRequired': 'Search text is required',
      'backlink.propertyKeyRequired': 'Property key is required',
      'backlink.invalidNumber': 'Invalid number',
      'backlink.dateValueRequired': 'Date value is required',
      'backlink.dateRangeRequired': 'At least one date boundary is required',
      'backlink.invalidDateAfter': 'Invalid date format for "after" (expected YYYY-MM-DD)',
      'backlink.invalidDateBefore': 'Invalid date format for "before" (expected YYYY-MM-DD)',
      'backlink.tagRequired': 'Tag is required',
      'backlink.tagPrefixRequired': 'Tag prefix is required',
      'backlink.addFilterLabel': 'Add filter',
      'backlink.filterCategoryLabel': 'Filter category',
      'backlink.selectFilter': 'Select filter...',
      'backlink.typeOption': 'Block Type',
      'backlink.statusOption': 'Status',
      'backlink.priorityOption': 'Priority',
      'backlink.containsOption': 'Contains',
      'backlink.propertyOption': 'Property',
      'backlink.createdDateOption': 'Created Date',
      'backlink.propertyIsSetOption': 'Property Is Set',
      'backlink.propertyIsEmptyOption': 'Property Is Empty',
      'backlink.hasTagOption': 'Has Tag',
      'backlink.tagPrefixOption': 'Tag Prefix',
      'backlink.blockTypeValueLabel': 'Block type value',
      'backlink.contentType': 'Content',
      'backlink.pageType': 'Page',
      'backlink.tagType': 'Tag',
      'backlink.statusValueLabel': 'Status value',
      'backlink.todoStatus': 'TODO',
      'backlink.doingStatus': 'DOING',
      'backlink.doneStatus': 'DONE',
      'backlink.priorityValueLabel': 'Priority value',
      'backlink.highPriority': 'High [1]',
      'backlink.mediumPriority': 'Medium [2]',
      'backlink.lowPriority': 'Low [3]',
      'backlink.searchTextPlaceholder': 'Search text...',
      'backlink.containsTextLabel': 'Contains text',
      'backlink.propertyKeyLabel': 'Property key',
      'backlink.keyPlaceholder': 'key',
      'backlink.comparisonOpLabel': 'Comparison operator',
      'backlink.propertyTypeLabel': 'Property type',
      'backlink.textType': 'Text',
      'backlink.numberType': 'Number',
      'backlink.dateType': 'Date',
      'backlink.valuePlaceholder': 'value',
      'backlink.dateAfterLabel': 'Date after',
      'backlink.dateTo': 'to',
      'backlink.dateBeforeLabel': 'Date before',
      'backlink.tagLabel': 'Tag',
      'backlink.tagPrefixLabel': 'Tag prefix',
      'backlink.applyFilterLabel': 'Apply filter',
      'backlink.applyButton': 'Apply',
      'backlink.cancelAddingFilterLabel': 'Cancel adding filter',
      'backlink.cancelButton': 'Cancel',
      'backlink.filterAlreadyApplied': 'Filter already applied',
      'backlink.propertyValueLabel': 'Property value',
      'backlink.tagPrefixPlaceholder': 'Tag prefix...',
      'backlink.clearAllLabel': 'Clear all filters and sort',
      'backlink.clearAllButton': 'Clear all',
      'backlink.sortByLabel': 'Sort by',
      'backlink.defaultOrderOption': 'Default order',
      'backlink.createdOption': 'Created',
      'backlink.toggleSortLabel': 'Toggle sort direction (currently {{direction}})',
      'backlink.toggleSortDefault': 'Toggle sort direction',
      'backlink.ascSort': 'Asc',
      'backlink.descSort': 'Desc',
      'backlink.showingCount': 'Showing {{filtered}} of {{total}} backlinks',

      // Conflict list
      'conflict.emptyContent': '(empty)',
      'conflict.originalNotAvailable': '(original not available)',
      'conflict.updateSuccessDeleteFailed': 'Updated original but failed to remove conflict copy.',
      'conflict.retryDeleteButton': 'Retry delete',
      'conflict.conflictCopyRemoved': 'Conflict copy removed',
      'conflict.retryFailed': 'Retry failed \u2014 please delete the conflict manually.',
      'conflict.keptSelectedVersion': 'Kept selected version',
      'conflict.undoButton': 'Undo',
      'conflict.resolutionUndone': 'Resolution undone',
      'conflict.undoFailed': 'Failed to undo \u2014 check the original page.',
      'conflict.conflictDiscarded': 'Conflict discarded',
      'conflict.discardUndone': 'Discard undone',
      'conflict.undoDiscardFailed': 'Failed to undo discard.',
      'conflict.noConflicts':
        'No conflicts. Conflicts appear when the same block is edited on multiple devices.',
      'conflict.keepLabel': 'Keep Incoming',
      'conflict.discardLabel': 'Discard Incoming',
      'conflict.refreshLabel': 'Refresh conflict list',
      'conflict.deselectAllButton': 'Deselect all',
      'conflict.selectAllButton': 'Select all',
      'conflict.keepAllButton': 'Keep All Incoming',
      'conflict.discardAllButton': 'Discard All Incoming',
      'conflict.selectConflictLabel': 'Select conflict {{id}}',
      'conflict.viewOriginalLabel': 'View original block for {{id}}',
      'conflict.keepIncomingLabel': 'Keep incoming version for block {{id}}',
      'conflict.discardConflictLabel': 'Discard conflict for block {{id}}',

      // Pairing
      'pairing.cancelFailed': 'Failed to cancel pairing',
      'pairing.successMessage': 'Device paired successfully',
      'pairing.qrScannedMessage': 'QR code scanned \u2014 verify and tap Pair',
      'pairing.closeDialogLabel': 'Close pairing dialog',
      'pairing.dialogTitle': 'Pair Device',
      'pairing.startingMessage': 'Starting pairing...',
      'pairing.qrCodeLabel': 'QR code for device pairing',
      'pairing.passphraseLabel': 'Passphrase:',
      'pairing.scanOrEnterInstruction':
        'Scan the QR code or enter the passphrase on the other device.',
      'pairing.sessionExpiresIn': 'Session expires in',
      'pairing.sessionExpired': 'Session expired',
      'pairing.orSeparator': 'OR',
      'pairing.typePassphraseButton': 'Type Passphrase',
      'pairing.scanQrCodeButton': 'Scan QR Code',
      'pairing.wordPlaceholder': '{{ordinal}} word',
      'pairing.wordLabel': 'Passphrase word {{num}}',
      'pairing.loadingScannerMessage': 'Loading scanner...',
      'pairing.cancelButton': 'Cancel',
      'pairing.pairButton': 'Pair',
      'pairing.pairedDevicesTitle': 'Paired Devices',
      'pairing.noPairedDevices': 'No paired devices yet.',

      // Tag filter
      'tagFilter.title': 'Tag Filter',
      'tagFilter.searchPlaceholder': 'Search tags by prefix...',
      'tagFilter.searchLabel': 'Search tags by prefix',
      'tagFilter.selectedLabel': 'Selected:',
      'tagFilter.removeTagLabel': 'Remove tag {{name}}',
      'tagFilter.modeLabel': 'Mode:',
      'tagFilter.andMode': 'AND',
      'tagFilter.andModeTooltip': 'Show blocks with ALL selected tags',
      'tagFilter.orMode': 'OR',
      'tagFilter.orModeTooltip': 'Show blocks with ANY selected tag',
      'tagFilter.selectTagsMessage': 'Select tags above to filter blocks',
      'tagFilter.blockMatchOne': '{{count}} block matches',
      'tagFilter.blockMatchMany': '{{count}} blocks match',
      'tagFilter.matchingTagsTitle': 'Matching tags',
      'tagFilter.addButton': 'Add',
      'tagFilter.noMatchesFound': 'No matching blocks found.',
      'tagFilter.resultsTitle': 'Results',
      'tagFilter.emptyContent': '(empty)',
      'tagFilter.loadingMessage': 'Loading...',
      'tagFilter.loadMoreButton': 'Load more',
      'tagFilter.tagSingular': 'tag',
      'tagFilter.tagPlural': 'tags',

      // History view
      'history.filterLabel': 'Filter:',
      'history.allTypesOption': 'All types',
      'history.selectedBadge': 'selected',
      'history.revertingButton': 'Reverting...',
      'history.revertSelectedButton': 'Revert selected',
      'history.clearSelectionButton': 'Clear selection',
      'history.keyboardHint': 'Space to toggle, Enter to revert',
      'history.retryButton': 'Retry',
      'history.noEntriesFound': 'No history entries found',
      'history.selectOperationLabel': 'Select operation {{opType}} #{{seq}}',
      'history.diffButton': 'Diff',
      'history.nonReversibleTooltip': 'This operation cannot be reversed',

      // Trash view
      'trash.emptyMessage': 'Nothing in trash. Deleted items will appear here.',
      'trash.emptyContent': '(empty)',
      'trash.restoreTooltip': 'Restore this block from trash',
      'trash.restoreButton': 'Restore',
      'trash.purgeButton': 'Purge',
      'trash.loadingMessage': 'Loading...',
      'trash.loadMoreButton': 'Load more',
      'trash.permanentlyDeleteTitle': 'Permanently delete?',
      'trash.permanentlyDeleteDescription':
        'This action cannot be undone. This block will be permanently deleted.',
      'trash.noButton': 'No',
      'trash.yesDeleteButton': 'Yes, delete',
      'trash.selectAllButton': 'Select all',
      'trash.deselectAllButton': 'Deselect all',
      'trash.restoreAllButton': 'Restore all',
      'trash.purgeAllButton': 'Purge all',
      'trash.selectItemLabel': 'Select {{content}}',
      'trash.listLabel': 'Trash items',
      'trash.fromPage': 'from: {{page}}',
      'trash.deletedPage': '(deleted page)',
      'trash.batchRestored': '{{count}} blocks restored',
      'trash.batchPurged': '{{count}} blocks permanently deleted',
      'trash.batchPurgeTitle': 'Permanently delete {{count}} items?',
      'trash.batchPurgeDescription':
        'This action cannot be undone. {{count}} blocks will be permanently deleted.',
      'trash.regionLabel': 'Trash',
      'trash.filterPlaceholder': 'Filter deleted items...',
      'trash.showingCount': 'Showing {{filtered}} of {{total}} deleted items',
      'trash.noMatchMessage': 'No matching deleted items',
      'trash.clearFilter': 'Clear filter',

      // Device management
      'device.title': 'Device Management',
      'device.localDeviceIdLabel': 'Local Device ID',
      'device.deviceIdCopied': 'Device ID copied',
      'device.copyFailed': 'Failed to copy to clipboard',
      'device.copyDeviceIdLabel': 'Copy device ID to clipboard',
      'device.pairNewDeviceButton': 'Pair New Device',
      'device.pairedDevicesTitle': 'Paired Devices',
      'device.syncAllLabel': 'Sync with all paired devices',
      'device.syncAllButton': 'Sync All',
      'device.noPairedDevices': 'No paired devices. Click "Pair New Device" to get started.',
      'device.noAddress': 'No address',
      'device.editAddressLabel': 'Edit address for {{name}}',
      'device.renameDeviceLabel': 'Rename device {{name}}',
      'device.syncNowLabel': 'Sync now with device {{id}}',
      'device.syncNowButton': 'Sync Now',
      'device.unpairDeviceLabel': 'Unpair device {{id}}',
      'device.unpairButton': 'Unpair',
      'device.loadingMessage': 'Loading device information...',
      'device.syncingMessage': 'Syncing with device {{id}}...',
      'device.syncingAllMessage': 'Syncing with all paired devices...',
      'device.syncErrorMessage': 'Sync error: {{error}}',
      'device.retryButton': 'Retry',
      'device.dismissErrorLabel': 'Dismiss error',

      // Due panel (additions)
      'duePanel.emptyContent': '(empty)',
      'duePanel.duePanelLabel': 'Due items',
      'duePanel.showingScheduledTodayTooltip': 'Showing only tasks scheduled for today or earlier',
      'duePanel.showingAllTasksTooltip': 'Showing all tasks regardless of scheduled date',
      'duePanel.scheduledHideFutureButton': 'Scheduled: hide future',
      'duePanel.scheduledShowAllButton': 'Scheduled: show all',
      'duePanel.overdueTitle': 'Overdue',
      'duePanel.upcomingTitle': 'Upcoming',

      // QR scanner
      'qrScanner.viewportLabel': 'QR code scanner viewport',
      'qrScanner.cameraPreview': 'Camera preview',
      'qrScanner.retryCameraButton': 'Retry Camera',
      'qrScanner.scanQrCodeButton': 'Scan QR Code',
      'qrScanner.scanningMessage': 'Scanning...',

      // Page property table
      'pageProperty.loadFailed': 'Failed to load properties',
      'pageProperty.saveFailed': 'Failed to save property',
      'pageProperty.deleteFailed': 'Failed to delete property',
      'pageProperty.addFailed': 'Failed to add property',
      'pageProperty.toggleLabel': 'Toggle properties',
      'pageProperty.propertiesButton': 'Properties',
      'pageProperty.addPropertyLabel': 'Add property',
      'pageProperty.addPropertyButton': 'Add property',
      'pageProperty.pickerLabel': 'Property picker',
      'pageProperty.searchPlaceholder': 'Search definitions...',
      'pageProperty.searchLabel': 'Search definitions',
      'pageProperty.createButton': 'Create "{{name}}"',
      'pageProperty.valueTypeLabel': 'Value type',
      'pageProperty.textType': 'text',
      'pageProperty.numberType': 'number',
      'pageProperty.dateType': 'date',
      'pageProperty.selectType': 'select',
      'pageProperty.refType': 'ref',
      'pageProperty.createDefinitionButton': 'Create definition',
      'pageProperty.updateOptionsFailed': 'Failed to update options',
      'pageProperty.valueLabel': '{{key}} value',
      'pageProperty.emptyOption': '\u2014',
      'pageProperty.editOptionsLabel': 'Edit options for {{key}}',
      'pageProperty.removeOptionLabel': 'Remove option {{option}}',
      'pageProperty.newOptionPlaceholder': 'New option...',
      'pageProperty.newOptionLabel': 'New option value',
      'pageProperty.addOptionLabel': 'Add option',
      'pageProperty.saveOptionsButton': 'Save options',
      'pageProperty.deletePropertyLabel': 'Delete property {{key}}',
      'pageProperty.loadPagesFailed': 'Failed to load pages',

      // Source page filter
      'sourceFilter.filterLabel': 'Filter by source page',
      'sourceFilter.searchPlaceholder': 'Search pages...',
      'sourceFilter.searchLabel': 'Search source pages',
      'sourceFilter.noPagesFound': 'No pages found',
      'sourceFilter.clearAllButton': 'Clear all',

      // Search panel (additions)
      'search.failed': 'Failed to search',
      'search.loadResultsFailed': 'Failed to load search results',
      'search.noParentPage': 'This block has no parent page',
      'search.searchPlaceholder': 'Search blocks...',
      'search.searchLabel': 'Search blocks',
      'search.cjkNoteLabel': 'Note:',
      'search.cjkLimitationNote': 'CJK search is limited in v1. Some results may be incomplete.',
      'search.recentTitle': 'Recent',
      'search.noResultsFound': 'No results found. Try different keywords or check your spelling.',
      'search.loadingMessage': 'Loading...',
      'search.loadMoreButton': 'Load more',
      'search.resultsCount': '{{count}} results found',
      'search.addPage': '+ Page',
      'search.addTag': '+ Tag',
      'search.clearAll': 'Clear all',
      'search.inPage': 'in: {{name}}',
      'search.removePageFilter': 'Remove page filter',
      'search.removeTagFilter': 'Remove tag {{name}}',
      'search.searchPages': 'Search pages...',
      'search.searchTags': 'Search tags...',
      'search.noPagesFound': 'No pages found',
      'search.noTagsFound': 'No tags found',
      'search.filtersActive': 'Filters active',

      // Status panel (additions)
      'status.foregroundQueueTooltip':
        'Operations waiting to be applied to the database. Should stay near zero.',
      'status.backgroundQueueTooltip':
        'Cache rebuild and FTS indexing tasks. Non-critical, best-effort processing.',
      'status.opsDispatchedTooltip': 'Total operations processed since app start.',
      'status.backgroundDispatchedTooltip':
        'Total background cache tasks completed since app start.',
      'status.peerCountTooltip': 'Number of paired devices',
      'status.lastSyncedTooltip': 'Time since last successful sync',
      'status.opsReceivedTooltip': 'Total operations received from peers (resets on app restart)',
      'status.opsSentTooltip': 'Total operations sent to peers (resets on app restart)',
      'status.importedMessage': 'Imported {{totalBlocks}} blocks from {{fileCount}} file(s)',
      'status.materializerStatusTitle': 'Materializer Status',
      'status.foregroundQueueLabel': 'Foreground Queue',
      'status.peakLabel': 'Peak:',
      'status.backgroundQueueLabel': 'Background Queue',
      'status.opsDispatchedLabel': 'Ops Processed',
      'status.backgroundDispatchedLabel': 'Background Dispatched',
      'status.foregroundErrorsMessage_one': '{{count}} foreground error',
      'status.foregroundErrorsMessage_other': '{{count}} foreground errors',
      'status.backgroundErrorsMessage_one': '{{count}} background error',
      'status.backgroundErrorsMessage_other': '{{count}} background errors',
      'status.foregroundPanicsMessage_one': '{{count}} foreground panic',
      'status.foregroundPanicsMessage_other': '{{count}} foreground panics',
      'status.backgroundPanicsMessage_one': '{{count}} background panic',
      'status.backgroundPanicsMessage_other': '{{count}} background panics',
      'status.cacheStaleHint': 'Cache data may be stale. Restart the app to retry.',
      'status.syncStatusTitle': 'Sync Status',
      'status.notConfigured': 'Not configured',
      'status.syncStateLabel': 'Sync state: {{state}}',
      'status.peerLabel_one': 'Peer',
      'status.peerLabel_other': 'Peers',
      'status.lastSyncedLabel': 'Last Synced',
      'status.opsReceivedLabel': 'Ops Received',
      'status.opsSentLabel': 'Ops Sent',
      'status.importingMessage': 'Importing...',

      // Undo shortcuts
      'undo.undoneMessage': 'Undone',
      'undo.undoFailedMessage': 'Undo failed',
      'undo.redoneMessage': 'Redone',
      'undo.redoFailedMessage': 'Redo failed',

      // Block tree
      'blockTree.updateFailedMessage': '{{failCount}} of {{totalCount}} failed to update',
      'blockTree.setStateMessage': 'Set {{successCount}} block(s) to {{state}}',
      'blockTree.deleteFailedMessage': '{{failCount}} of {{totalCount}} failed to delete',
      'blockTree.deletedMessage': 'Deleted {{count}} block(s)',
      'blockTree.setTaskStateFailed': 'Failed to set task state',
      'blockTree.linkTargetNotFound': 'Link target not found',
      'blockTree.setPriorityFailed': 'Failed to set priority',
      'blockTree.setHeadingFailed': 'Failed to set heading',
      'blockTree.addedPropertyMessage': 'Added {{name}} property',
      'blockTree.addPropertyFailed': 'Failed to add property',
      'blockTree.addedAssigneeProperty': 'Added assignee property',
      'blockTree.setAssigneeMessage': 'Set assignee to {{value}}',
      'blockTree.setAssigneeFailed': 'Failed to set assignee',
      'blockTree.addedLocationProperty': 'Added location property',
      'blockTree.setLocationMessage': 'Set location to {{value}}',
      'blockTree.setLocationFailed': 'Failed to set location',
      'blockTree.repeatEndConditionRemoved': 'Repeat end condition removed',
      'blockTree.removeEndConditionFailed': 'Failed to remove end condition',
      'blockTree.repeatLimitedMessage': 'Repeat limited to {{count}} occurrences',
      'blockTree.setRepeatLimitFailed': 'Failed to set repeat limit',
      'blockTree.filePathReadFailed': 'Could not read file path \u2014 use drag & drop instead',
      'blockTree.attachedFileMessage': 'Attached "{{filename}}"',
      'blockTree.attachFileFailed': 'Failed to attach file',
      'blockTree.cannotDeleteLastBlock': 'Cannot delete the last block on a page',
      'blockTree.mergeBlocksFailed': 'Failed to merge blocks',
      'blockTree.noBlocks': 'No blocks yet. Click + Add block below to start writing.',
      'blockTree.emptyPage': 'Creating first block\u2026',
      'blockTree.treeLabel': 'Block tree',
      'blockTree.createFirstBlockFailed': 'Failed to create first block',

      // Error toasts (stores/hooks)
      'error.loadBlocksFailed': 'Failed to load blocks',
      'error.deleteBlockFailed': 'Failed to delete block',
      'error.reorderBlockFailed': 'Failed to reorder block',
      'error.moveBlockFailed': 'Failed to move block',
      'error.indentBlockFailed': 'Failed to indent block',
      'error.dedentBlockFailed': 'Failed to dedent block',
      'error.moveBlockUpFailed': 'Failed to move block up',
      'error.moveBlockDownFailed': 'Failed to move block down',
      'error.createPageFailed': 'Failed to create page',

      // Attachment toasts
      'attachments.loadFailed': 'Failed to load attachments',
      'attachments.addFailed': 'Failed to add attachment',
      'attachments.deleteFailed': 'Failed to delete attachment',

      // Tag toasts
      'tags.addFailed': 'Failed to add tag',
      'tags.deleteFailed': 'Failed to delete tag',
      'tags.createFailed': 'Failed to create tag',

      // Sync toasts + aria-labels
      'device.syncComplete': 'Sync complete',
      'device.syncFailed': 'Sync failed',
      'device.deviceNameLabel': 'Device name',

      // History toasts + aria-labels
      'history.loadFailed': 'Failed to load history',
      'history.revertFailed': 'Failed to revert operations',
      'history.restoreToHereLabel': 'Restore to this point',
      'history.restoreToHereTooltip': 'Revert all operations after this point',
      'history.restoreToTitle': 'Restore to {{timestamp}}?',
      'history.restoreToDescription':
        'This will revert all operations that occurred after this point. Non-reversible operations (purge) will be skipped. The original operations remain in history.',
      'history.restoreSuccess': '{{count}} operations reverted successfully',
      'history.restoreSkipped': '{{count}} non-reversible operations were skipped',
      'history.restoreFailed': 'Failed to restore — please try again',
      'history.cancelButton': 'Cancel',
      'history.restoreButton': 'Restore',
      'history.revertedSuccessfully': 'Reverted successfully',
      'history.revertPanelFailed': 'Failed to revert',
      'history.loadDiffFailed': 'Failed to load diff',
      'history.filterByTypeLabel': 'Filter by operation type',
      'history.entriesLabel': 'History entries',
      'history.nonReversibleLabel': 'Non-reversible',

      // Trash toasts
      'trash.blockRestored': 'Block restored',
      'trash.restoreFailed': 'Failed to restore block',
      'trash.blockPurged': 'Block permanently deleted',
      'trash.purgeFailed': 'Failed to purge block',

      // Block tree toasts + aria-labels
      'blockTree.setDueDateFailed': 'Failed to set due date',
      'blockTree.repeatUntilMessage': 'Repeat until {{date}}',
      'blockTree.setRepeatEndDateFailed': 'Failed to set repeat end date',
      'blockTree.setScheduledDateFailed': 'Failed to set scheduled date',
      'blockTree.setPropertyFailed': 'Failed to set property',
      'blockTree.loadingLabel': 'Loading blocks',

      // Property toasts + aria-labels
      'property.renameFailed': 'Failed to rename property',
      'property.editKeyLabel': 'Edit property {{key}}',
      'property.selectValue': '{{key}}: {{value}}',

      // Templates toasts
      'templates.removeTemplateFailed': 'Failed to remove template status',
      'templates.templateRemoved': 'Removed template status from {{name}}',

      // Journal aria-labels
      'journal.datePickerLabel': 'Date picker',
      'journal.viewModeLabel': 'Journal view mode',
      'journal.typeDateLabel': 'Type a date',
      'journal.monthlyViewButtonLabel': 'Go to monthly view',
      'journal.goToWeek': 'Go to week {{weekNum}}',

      // References aria-labels + empty state (UX-13)
      'references.panelLabel': 'References',
      'references.noReferences': 'No references to this page yet.',

      // Unlinked references aria-labels
      'unlinkedRefs.panelLabel': 'Unlinked references',

      // Backlink aria-labels
      'backlink.filtersLabel': 'Backlink filters',
      'backlink.appliedFiltersLabel': 'Applied filters',

      // Other aria-labels
      'propertiesView.optionsJsonLabel': 'Options JSON',
      'conflict.unresolvedLabel': 'Has unresolved conflicts',
      'pageHeader.breadcrumbLabel': 'Page breadcrumb',
      'pdfViewer.previousPageLabel': 'Previous page',
      'pdfViewer.nextPageLabel': 'Next page',
      'block.editLabel': 'Edit block',
      'tagList.deleteTagLabel': 'Delete tag',
      'tagList.renameTagLabel': 'Rename tag',
      'tagList.renameInputLabel': 'New tag name',
      'tagList.newTagLabel': 'New tag name',
      'tagList.colorTagLabel': 'Set tag color',
      'tagList.colorPaletteLabel': 'Color palette',
      'tagList.clearColor': 'Clear color',

      // Common (collapsible panels)
      'common.expand': 'Expand {{section}}',
      'common.collapse': 'Collapse {{section}}',

      // Done panel empty state (UX-13)
      'donePanel.empty': 'No completed items yet.',

      // Accessibility
      'accessibility.skipToMain': 'Skip to main content',

      // UX-53: Clear all filters
      'agendaFilter.clearAll': 'Clear all',
      'agendaFilter.clearAllLabel': 'Clear all filters',

      // UX-56: Overdue duration
      'duePanel.daysOverdue_one': '{{count}}d overdue',
      'duePanel.daysOverdue_other': '{{count}}d overdue',

      // UX-64: Empty block placeholder
      'block.emptyPlaceholder': 'Type / for commands...',

      // UX-72: Journal template tooltip
      'templates.journalTooltip':
        'This template is automatically applied when creating new journal entries',

      // UX-57: Calendar dot legend
      'journal.legendPage': 'Page',
      'journal.legendDue': 'Due',
      'journal.legendScheduled': 'Scheduled',
      'journal.legendProperty': 'Property',

      // UX-70: NOT operator in tag query
      'tagFilter.notMode': 'NOT',
      'tagFilter.notModeTooltip': 'Show blocks WITHOUT any selected tag',

      // UX-74: Template toggle button
      'pageHeader.toggleTemplate': 'Toggle template status',
      'pageHeader.templateActive': 'Page is a template',

      // UX-73: Template removal confirmation
      'templates.removeConfirmTitle': 'Remove template status',
      'templates.removeConfirmDesc':
        'Remove template status from "{{name}}"? Pages already created from this template will not be affected.',

      // UX-41: Property actions
      'property.saved': 'Property saved',
      'property.deleted': 'Property deleted',
      'property.dateCleared': 'Date cleared',
      'property.dateUpdated': 'Date updated',

      // UX-41: Conflict dialogs
      'conflict.loadFailed': 'Failed to load conflicts',
      'conflict.keepIncomingTitle': 'Keep incoming version?',
      'conflict.discardTitle': 'Discard conflict?',
      'conflict.keepAllSelectedTitle': 'Keep all selected?',
      'conflict.discardAllSelectedTitle': 'Discard all selected?',

      // UX-41: Trash
      'trash.loadFailed': 'Failed to load trash',

      // UX-41: History
      'history.loadedMoreEntries': 'Loaded {{count}} more entries',

      // F-20: Op Log Compaction
      'compaction.title': 'Op Log Compaction',
      'compaction.totalOps': 'Total operations: {{count}}',
      'compaction.oldestOp': 'Oldest operation: {{date}}',
      'compaction.oldestOpNone': 'Oldest operation: N/A',
      'compaction.eligibleOps': 'Eligible for cleanup: {{count}}',
      'compaction.compactNow': 'Compact Now',
      'compaction.confirmTitle': 'Compact Op Log?',
      'compaction.confirmDescription':
        'This will permanently delete {{count}} operations older than {{days}} days. The original data in these operations will be lost. This cannot be undone.',
      'compaction.compactButton': 'Compact',
      'compaction.cancel': 'Cancel',
      'compaction.success': 'Compacted {{count}} operations',
      'compaction.failed': 'Failed to compact op log',
      'compaction.loadFailed': 'Failed to load compaction status',

      // UX-41: Pairing
      'pairing.inProgress': 'Pairing in progress...',

      // UX-41: PDF viewer
      'pdfViewer.description': 'PDF viewer for {{filename}}',
      'pdfViewer.loading': 'Loading PDF...',
      'pdfViewer.error': 'Error: {{error}}',
      'pdfViewer.pageIndicator': 'Page {{current}} / {{total}}',

      // UX-41: Suggestions
      'suggestion.noResults': 'No results',
      'suggestion.create': 'Create',

      // UX-41: Page browser
      'pageBrowser.loadedMorePages': 'Loaded {{count}} more pages',

      // UX-42: Accessibility text
      'sidebar.label': 'Sidebar',
      'ui.close': 'Close',
      'link.opensInNewTab': '(opens in new tab)',
      'backlink.filtersLegend': 'Backlink filters',
      'backlink.filtersApplied_one': '{{count}} filter applied',
      'backlink.filtersApplied_other': '{{count}} filters applied',

      // UX-43: Theme
      'sidebar.toggleTheme': 'Toggle theme',
      'sidebar.themeDark': 'Dark mode',
      'sidebar.themeLight': 'Light mode',

      // UX-60: Sidebar badge counts
      'sidebar.conflictCount': '{{count}} unresolved conflicts',
      'sidebar.trashCount': '{{count}} items in trash',

      // UX-76: Sync status
      'sidebar.lastSynced': 'Last synced {{time}}',
      'sidebar.lastSyncedNever': 'Never synced',
      'sidebar.justNow': 'just now',
      'sidebar.minutesAgo': '{{count}}m ago',
      'sidebar.hoursAgo': '{{count}}h ago',
      'sidebar.daysAgo': '{{count}}d ago',

      // UX-71: Tag filter breadcrumbs
      'tagFilter.inPage': 'in:',

      // UX-88: NL date input
      'property.datePlaceholder': 'today, +3d, Apr 15, 2025-04-15',
      'property.dateParseError': 'Could not parse date',
      'datePicker.parsed': 'Parsed:',
      'datePicker.pressEnter': 'press Enter to apply',

      // UX-77: Manual address entry
      'device.editAddressTitle': 'Peer address',
      'device.addressInputLabel': 'Address (host:port)',
      'device.addressHint': 'Format: host:port (e.g., 192.168.1.100:5000)',
      'device.saveAddressButton': 'Save',

      // UX-61: Page metadata bar
      'metadata.label': 'Info',
      'metadata.toggleLabel': 'Toggle page metadata',
      'metadata.wordCount_one': '{{count}} word',
      'metadata.wordCount_other': '{{count}} words',
      'metadata.blockCount_one': '{{count}} block',
      'metadata.blockCount_other': '{{count}} blocks',
      'metadata.created': 'Created {{date}}',

      // UX-89: Page outline / table of contents
      'pageHeader.openOutline': 'Open outline',
      'outline.title': 'Outline',
      'outline.empty': 'No headings found',
      'outline.navLabel': 'Page outline',

      // UX-84: Image lightbox
      'lightbox.description': 'Fullscreen preview of {{filename}}',
      'lightbox.openExternal': 'Open externally',

      // UX-85: Image resize controls
      'imageResize.toolbar': 'Image size',
      'imageResize.small': 'Small (25%)',
      'imageResize.medium': 'Medium (50%)',
      'imageResize.large': 'Large (75%)',
      'imageResize.full': 'Full (100%)',

      // F-23: Unfinished tasks carry-over
      'unfinished.title': 'Unfinished Tasks',
      'unfinished.sectionLabel': 'Unfinished tasks from previous days',
      'unfinished.empty': 'No unfinished tasks — you\u2019re all caught up!',
      'unfinished.yesterday': 'Yesterday',
      'unfinished.thisWeek': 'This Week',
      'unfinished.older': 'Older',
      'unfinished.untitled': 'Untitled',
      'unfinished.breadcrumbArrow': '\u2192',

      // UX-62: Code block language selector
      'toolbar.codeBlockLanguageTip': 'Code block language',
      'toolbar.codeBlockLanguage': 'Code block language',
      'toolbar.plainText': 'Plain text',

      // F-31: Welcome / onboarding modal
      'welcome.title': 'Welcome to Agaric',
      'welcome.description': 'A local-first note-taking app for organizing your thoughts.',
      'welcome.featureBlocks': 'Blocks + pages',
      'welcome.featureBlocksDesc': 'Build knowledge with nested blocks organized into pages.',
      'welcome.featureShortcuts': 'Keyboard shortcuts',
      'welcome.featureShortcutsDesc': 'Press ? any time to see all available shortcuts.',
      'welcome.featureTags': 'Tags + properties',
      'welcome.featureTagsDesc': 'Organize and filter your notes with tags and custom properties.',
      'welcome.getStarted': 'Get Started',
      'welcome.createSamplePages': 'Create sample pages',
      'welcome.samplePagesCreated': 'Sample pages created!',
      'welcome.samplePagesFailed': 'Failed to create sample pages',

      // F-30: Settings view
      'sidebar.settings': 'Settings',
      'settings.tabGeneral': 'General',
      'settings.tabProperties': 'Properties',
      'settings.tabAppearance': 'Appearance',
      'settings.tabSync': 'Sync & Devices',
      'settings.themeLabel': 'Theme',
      'settings.themeLight': 'Light',
      'settings.themeDark': 'Dark',
      'settings.themeSystem': 'System',
      'settings.fontSizeLabel': 'Font Size',
      'settings.fontSizeSmall': 'Small',
      'settings.fontSizeMedium': 'Medium',
      'settings.fontSizeLarge': 'Large',

      // UX-86: Keyboard settings
      'settings.tabKeyboard': 'Keyboard',
      'keyboard.settings.title': 'Keyboard Shortcuts',
      'keyboard.settings.description':
        'Customize keyboard shortcuts. Click the edit button to change a binding.',
      'keyboard.settings.editShortcutFor': 'Edit shortcut for {{action}}',
      'keyboard.settings.saveButton': 'Save',
      'keyboard.settings.cancelButton': 'Cancel',
      'keyboard.settings.resetButton': 'Reset to default',
      'keyboard.settings.resetShortcutFor': 'Reset {{action}} to default',
      'keyboard.settings.resetAllButton': 'Reset All to Defaults',
      'keyboard.settings.resetAllConfirm':
        'Reset all keyboard shortcuts to their default bindings?',
      'keyboard.settings.resetAllTitle': 'Reset all shortcuts?',
      'keyboard.settings.conflictWarning': 'Conflicts with: {{shortcuts}}',
      'keyboard.settings.customized': 'Customized',
      'keyboard.settings.typeNewBinding': 'Type new key binding...',
      'keyboard.settings.emptyBinding': 'Key binding cannot be empty',

      // F-35: Mermaid diagrams
      'mermaid.loading': 'Rendering diagram…',
      'mermaid.error': 'Diagram error',
      'mermaid.label': 'Mermaid diagram',
    },
  },
}

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
})

/** Standalone translation function — safe to call outside React components. */
export const t = i18n.t.bind(i18n)

export default i18n
