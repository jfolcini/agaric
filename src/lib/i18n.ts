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
      'sidebar.shortcuts': 'Keyboard shortcuts',

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

      // Formatting toolbar
      'toolbar.bold': 'Bold',
      'toolbar.italic': 'Italic',
      'toolbar.code': 'Code',
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
      'toolbar.setDueDate': 'Set due date',
      'toolbar.undo': 'Undo',
      'toolbar.redo': 'Redo',
      'toolbar.paragraph': 'Paragraph',

      // Formatting toolbar — tooltips
      'toolbar.boldTip': 'Bold (Ctrl+B)',
      'toolbar.italicTip': 'Italic (Ctrl+I)',
      'toolbar.codeTip': 'Inline code (Ctrl+E)',
      'toolbar.linkTip': 'External link (Ctrl+K)',
      'toolbar.pageLinkTip': 'Page link ([[)',
      'toolbar.tagTip': 'Tag (@)',
      'toolbar.codeBlockTip': 'Code block (Ctrl+Shift+C)',
      'toolbar.headingTip': 'Heading (Ctrl+1-6)',
      'toolbar.priority1Tip': 'Priority 1 — high (Ctrl+Shift+1)',
      'toolbar.priority2Tip': 'Priority 2 — medium (Ctrl+Shift+2)',
      'toolbar.priority3Tip': 'Priority 3 — low (Ctrl+Shift+3)',
      'toolbar.insertDateTip': 'Insert date (Ctrl+Shift+D)',
      'toolbar.dueDateTip': 'Due date (/due)',
      'toolbar.todoToggleTip': 'TODO cycle (Ctrl+Enter)',
      'toolbar.undoTip': 'Undo (Ctrl+Z)',
      'toolbar.redoTip': 'Redo (Ctrl+Y)',
      'toolbar.discardTip': 'Discard changes (Esc)',

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

      // Errors
      'error.generic': 'Something went wrong',
      'error.loadFailed': 'Failed to load data',
      'error.saveFailed': 'Failed to save',
      'error.createBlockFailed': 'Failed to create block',

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
      'duePanel.filterAll': 'All',
      'duePanel.filterDue': 'Due',
      'duePanel.filterScheduled': 'Scheduled',
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

export default i18n
