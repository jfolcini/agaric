/**
 * i18n namespace: agenda
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const agenda: Record<string, string> = {
  // Translators: Heading of the DonePanel, the collapsible panel under a Journal day (or a date
  // page) that lists the tasks completed that day; {{count}} = number of completed tasks.
  'donePanel.header_one': '{{count}} Completed',
  'donePanel.header_other': '{{count}} Completed',

  // Translators: DonePanel. "Load more" button under the list, its text while loading, and its
  // screen-reader labels. "→" separates a page title from the task in each row (keep an arrow
  // pointing in your reading direction). "Untitled" = name shown for a page with no title.
  // "Completed items" = screen-reader name of the panel; {{title}} = a page title.
  'donePanel.loading': 'Loading...',
  'donePanel.loadMore': 'Load more',
  'donePanel.breadcrumbArrow': '\u2192',
  'donePanel.untitled': 'Untitled',
  'donePanel.completedItems': 'Completed items',
  'donePanel.loadingMore': 'Loading more completed items',
  'donePanel.loadMoreLabel': 'Load more completed items',
  'donePanel.groupItemsLabel': '{{title}} completed items',

  // Translators: DonePanel error line when the list cannot load, with its Retry button and the
  // button's screen-reader label.
  'donePanel.loadError': 'Failed to load completed items.',
  'donePanel.retry': 'Retry',
  'donePanel.retryLabel': 'Retry loading completed items',

  // Translators: Agenda tab of the Journal (the list of all your tasks, with filters): loading
  // text and empty states. "todo state" = a task keyword such as TODO or DONE set on a block.
  'agenda.loadingTasks': 'Loading tasks...',
  'agenda.noTasks': 'No tasks found. Set a todo state on your blocks to see them here.',
  // Translators: Shown when the filters hide every task, above a "Clear all filters" button.
  'agenda.noMatch': 'No blocks match your filters.',

  // Translators: Agenda tab of the Journal: error card (title and body) when the task list
  // cannot load, and toasts (brief pop-up messages, with a Retry action) when more tasks or the
  // projected occurrences cannot load.
  // "Projected occurrences" = the upcoming dates of repeating tasks, computed in advance.
  'agenda.loadFailed': 'Failed to load agenda',
  'agenda.loadFailedBody': 'Something went wrong loading your agenda. Try again.',
  'agenda.loadMoreFailed': 'Failed to load more agenda items',
  'agenda.loadProjectedFailed': 'Failed to load projected occurrences',

  // Translators: Agenda tab of the Journal: button under the "No blocks match your filters"
  // message.
  'agenda.clearFilters': 'Clear all filters',

  // Translators: Agenda tab of the Journal: screen-reader-only count of the tasks in the list,
  // read out when it changes; {{count}} = number of tasks (2 or more).
  'agenda.zeroResults': '0 results',
  'agenda.resultOne': '1 result',
  'agenda.resultCount': '{{count}} results',

  // Translators: Agenda tab of the Journal: notice above the task list while only part of the
  // tasks has been loaded ("load more" refers to the "Load more" button at the bottom).
  // #3291 — shown while `hasMore` is true: sorting AND grouping both run
  // client-side over the fetched window only, so neither the visible order nor
  // the per-group header counts describe the whole agenda. Naming grouping is
  // not padding: the shipped default is `groupBy: 'page'`
  // (useAgendaPreferences.ts), and each header renders
  // `({group.blocks.length})` — a count over the loaded window presented with
  // no qualifier. A sort-only sentence leaves that number looking authoritative.
  //
  // Sibling covering the same "client-side sort over a loaded prefix" shape:
  // `query.sortPartialNotice_one/_other` (properties.ts), which DOES carry a
  // count — of LOADED rows — with i18next plural suffixes. This key deliberately
  // carries none, so it needs no plural form: `blocks.length` is already
  // announced by the sibling `agenda.resultCount` live region two lines up in
  // AgendaResults, and repeating it here would restate the very window whose
  // completeness is in question. The count that WOULD be informative — how many
  // matches remain unfetched — is exactly what the frontend cannot know.
  'agenda.partialOrderNotice':
    'Sorted and grouped within the tasks loaded so far — load more to cover the whole agenda.',

  // Translators: Agenda tab of the Journal: "Load more" buttons at the bottom of the task list and
  // of the list of projected occurrences (upcoming dates of repeating tasks), the button text while
  // loading, and their screen-reader labels.
  'agenda.loadMore': 'Load more',
  'agenda.loading': 'Loading...',
  // Translators: Name shown for a page that has no title.
  'agenda.untitled': 'Untitled',
  'agenda.loadingMore': 'Loading more tasks',
  'agenda.loadMoreLabel': 'Load more tasks',
  'agenda.loadMoreProjectedLabel': 'Load more projected occurrences',
  'agenda.loadingMoreProjected': 'Loading more projected occurrences',

  // Translators: Agenda tab of the Journal: screen-reader name of the task list.
  'agenda.agendaResults': 'Agenda results',

  // Translators: Agenda tab of the Journal: group headings when tasks are grouped by date.
  // "Overdue" = past its due date; "No date" = tasks without a date.
  'agenda.overdue': 'Overdue',
  'agenda.today': 'Today',
  'agenda.tomorrow': 'Tomorrow',
  'agenda.noDate': 'No date',

  // Translators: Agenda tab of the Journal: the "Sort by" and "Group by" drop-downs and their
  // choices. Screen readers hear both labels joined as "Sort by / Group by". "State" = the task
  // state (TODO, DOING, DONE …); "Page" = the page the task is on; "None" = no grouping.
  'agenda.sortBy': 'Sort by',
  'agenda.groupBy': 'Group by',
  'agenda.sortDate': 'Date',
  'agenda.sortPriority': 'Priority',
  'agenda.sortState': 'State',
  'agenda.groupDate': 'Date',
  'agenda.groupPriority': 'Priority',
  'agenda.groupState': 'State',
  'agenda.groupNone': 'None',
  'agenda.groupPage': 'Page',
  'agenda.sortPage': 'Page',

  // Translators: Agenda tab of the Journal: group heading, when grouped by page, for tasks that
  // belong to no page.
  'agenda.noPage': 'No page',

  // Translators: Agenda tab of the Journal: separator between a page title and the task in each
  // row. Keep an arrow pointing in your reading direction.
  'agenda.breadcrumbArrow': '\u2192',

  // Translators: Tooltip of the small "blocked" icon on a task that waits for another task;
  // {{title}} = the text of the task it waits for. The last string is a warning toast (brief
  // pop-up message) when you complete a task whose dependencies may still be open.
  'dependency.blockedBy': 'Blocked by: {{title}}',
  'dependency.blockedByUnresolved': 'Blocked by another task',
  'dependency.dependencyWarning': 'This task has dependencies that may not be complete',

  // Translators: Date chip on a task in the Agenda (shows its due date) and the small editor it
  // opens. "Edit date" = screen-reader label of the chip and title of the editor on phones.
  // The placeholder lists examples of what can be typed; the date parser understands only these
  // English words, so keep "today" and "Apr" in English. "Clear" = remove the date (verb).
  // The last three strings are toasts (brief pop-up messages) after a change.
  'dateChip.editDate': 'Edit date',
  'dateChip.placeholder': 'today, +3d, Apr 15',
  'dateChip.inputLabel': 'Type a date',
  'dateChip.today': 'Today',
  'dateChip.tomorrow': 'Tomorrow',
  'dateChip.nextWeek': 'Next week',
  'dateChip.clear': 'Clear',
  'dateChip.dateUpdated': 'Date updated',
  'dateChip.dateCleared': 'Date cleared',
  'dateChip.updateFailed': 'Failed to update date',

  // Translators: Agenda filters (the filter bar above the Agenda's task list): names of the things
  // you can filter by, in the "Add filter" menu and on filter chips ("Status: TODO"). They are
  // also inserted as {{label}} in the agendaFilter strings below. "Status" = the task state
  // (TODO, DONE …); "Property" = a custom field set on blocks.
  'agendaFilter.status': 'Status',
  'agendaFilter.priority': 'Priority',
  'agendaFilter.dueDate': 'Due date',
  'agendaFilter.scheduledDate': 'Scheduled date',
  'agendaFilter.completedDate': 'Completed date',
  'agendaFilter.createdDate': 'Created date',
  'agendaFilter.tag': 'Tag',
  'agendaFilter.property': 'Property',

  // Translators: Agenda filters, "Property" filter form: field labels, the value input's
  // placeholder, and the drop-down placeholder for choosing which property to filter on.
  'agendaFilter.propertyKey': 'Property key',
  'agendaFilter.propertyValue': 'Value (optional)',
  'agendaFilter.propertyValuePlaceholder': 'Filter value...',
  'agendaFilter.selectProperty': 'Select property...',

  // Translators: Agenda filters, "Tag" filter form: the tag search input (placeholder and
  // screen-reader label) and the screen-reader name of its list of results.
  'agendaFilter.tagPlaceholder': 'Search tags...',
  'agendaFilter.tagName': 'Tag name',
  'agendaFilter.tagSearchResults': 'Matching tags',

  // Translators: Agenda filters: the "Add filter" button, the Apply button of the filter form (with
  // its screen-reader label), and the Remove button in a chip's edit menu.
  'agendaFilter.addFilter': 'Add filter',
  'agendaFilter.apply': 'Apply',
  'agendaFilter.applyFilter': 'Apply filter',
  'agendaFilter.removeFilter': 'Remove filter',

  // Translators: Agenda filters: hint next to the chips saying a task must match every filter
  // (AND as in logic). Then the count of active filters; {{count}} = 2 or more.
  'agendaFilter.combinedWithAnd': 'Filters combined with AND',
  'agendaFilter.filterAppliedOne': '1 filter applied',
  'agendaFilter.filtersApplied': '{{count}} filters applied',

  // Translators: Agenda filters: screen-reader name of the "Add filter" menu, and the headings of
  // its three sections (task fields, dates, and tags/properties).
  'agendaFilter.filterDimensions': 'Filter dimensions',
  'agendaFilter.group.taskMetadata': 'Task metadata',
  'agendaFilter.group.dates': 'Dates',
  'agendaFilter.group.organisation': 'Organisation',

  // Translators: Agenda filters: screen-reader names of the whole filter bar and of the list of
  // active filter chips.
  'agendaFilter.agendaFilters': 'Agenda filters',
  'agendaFilter.appliedFilters': 'Applied filters',

  // Translators: Agenda filters: screen-reader labels; {{label}} = a filter name such as "Status"
  // or "Priority", or a chip's text such as "Status: TODO" or "effort = 2".
  'agendaFilter.optionsLabel': '{{label}} options',
  'agendaFilter.editFilter': 'Edit {{label}} filter',
  'agendaFilter.removeFilterLabel': 'Remove {{label}} filter',
  // Translators: Tooltip on a property chip that has no effect; 'is set' quotes the filter.isSet
  // choice, keep it matching that label.
  'agendaFilter.valuedSubsumedByIsSet': "No effect — the property is already filtered as 'is set'",

  // Translators: Heading of the DuePanel, the collapsible panel under a Journal day (or a date
  // page) listing the tasks due or scheduled that day; {{count}} = number of tasks, followed by
  // the panel's name "Agenda".
  'duePanel.headerOne': '1 Agenda',
  'duePanel.header': '{{count}} Agenda',

  // Translators: DuePanel group headings by task state. DOING, TODO, DONE and CANCELLED are the
  // task keywords written in notes: keep them in English and capitals. "Other" = no task state.
  'duePanel.groupDoing': 'DOING',
  'duePanel.groupTodo': 'TODO',
  'duePanel.groupDone': 'DONE',
  'duePanel.groupCancelled': 'CANCELLED',
  'duePanel.groupOther': 'Other',

  // Translators: DuePanel: "Load more" button under the list, its text while loading, and its
  // screen-reader labels; then a toast (brief pop-up message) when the panel cannot load.
  // "→" separates a page title from the task in each row (keep an arrow pointing in your
  // reading direction). "Untitled" = name shown for a page with no title.
  'duePanel.loadMore': 'Load more',
  'duePanel.loading': 'Loading...',
  'duePanel.loadingMore': 'Loading more agenda items',
  'duePanel.loadMoreLabel': 'Load more agenda items',
  'duePanel.loadAgendaFailed': 'Failed to load agenda',
  'duePanel.breadcrumbArrow': '\u2192',
  'duePanel.untitled': 'Untitled',

  // Translators: DuePanel empty state when the selected filter button shows no tasks.
  'duePanel.noItemsForFilter': 'No items match this filter.',

  // Translators: DuePanel filter buttons (short, a count may follow in parentheses), their
  // explanations, and the screen-reader label of the ⓘ beside them that opens those. "Due" = has
  // a deadline; "Scheduled" = has a planned start day; "Properties" = matches a custom field.
  'duePanel.filterAll': 'All',
  'duePanel.filterDue': 'Due',
  'duePanel.filterScheduled': 'Scheduled',
  'duePanel.filterProperties': 'Properties',
  'duePanel.filterAllTooltip': 'All blocks with any due or scheduled date, or property filter',
  'duePanel.filterDueTooltip': 'Hard due date — overdue if past',
  'duePanel.filterScheduledTooltip': 'Soft scheduled start — not overdue if past',
  'duePanel.filterPropertiesTooltip': 'Filter by block properties (effort, assignee, etc.)',
  'duePanel.filterInfoLabel': 'About these filters',

  // Translators: DuePanel heading when the day's tasks come from more than one source, joined by
  // " · " as in "3 due · 2 scheduled · 1 by property". {{count}} = tasks from that source: a due
  // date, a scheduled date, or a matching property filter.
  'duePanel.countDue_one': '{{count}} due',
  'duePanel.countDue_other': '{{count}} due',
  'duePanel.countScheduled_one': '{{count}} scheduled',
  'duePanel.countScheduled_other': '{{count}} scheduled',
  'duePanel.countProperties_one': '{{count}} by property',
  'duePanel.countProperties_other': '{{count}} by property',

  // Translators: DuePanel: shown in place of the text of a task that has no text.
  'duePanel.emptyContent': '(empty)',

  // Translators: DuePanel: screen-reader name of the panel.
  'duePanel.duePanelLabel': 'Agenda',

  // Translators: DuePanel: switch label; hides tasks whose scheduled start day is still ahead.
  'duePanel.hideFutureScheduled': 'Hide future scheduled',

  // Translators: DuePanel section headings: "Overdue" = past their due date; "Projected" = upcoming
  // dates of repeating tasks, computed in advance (also a small chip on each such row);
  // "Upcoming" = due soon. "Projected entries" = screen-reader name of the projected list.
  'duePanel.overdueTitle': 'Overdue',
  'duePanel.projectedListLabel': 'Projected entries',
  'duePanel.projectedBadge': 'Projected',
  'due.projected': 'Projected',
  'duePanel.upcomingTitle': 'Upcoming',

  // Translators: DonePanel (tasks completed on a Journal day) empty state.
  'donePanel.empty': 'No completed items yet.',
  'donePanel.noneYet': 'No completed items yet.',

  // Translators: Agenda filters: button that removes every filter chip (short), and its
  // screen-reader label.
  'agendaFilter.clearAll': 'Clear all',
  'agendaFilter.clearAllLabel': 'Clear all filters',

  // Translators: DuePanel, after the due date of an overdue task, inside parentheses; "d" = days,
  // very short. {{count}} = number of days, e.g. "(3d overdue)".
  'duePanel.daysOverdue_one': '{{count}}d overdue',
  'duePanel.daysOverdue_other': '{{count}}d overdue',

  // Translators: Preview line under a date input: "Parsed: <the understood date> (press Enter to
  // apply)". The second part goes inside the parentheses, lower case.
  'datePicker.parsed': 'Parsed:',
  'datePicker.pressEnter': 'press Enter to apply',

  // Translators: Title of the date-picker dialog for a block's due date (deadline) or scheduled
  // date (planned start), and its button that removes the date.
  'datePicker.dueTitle': 'Due date',
  'datePicker.scheduledTitle': 'Scheduled date',
  'datePicker.clearDate': 'Clear date',

  // Translators: UnfinishedTasks, the collapsible section on today's Journal page listing tasks
  // from previous days that are not done: heading, screen-reader name, empty state, and group
  // headings by age. "→" separates a page title from the task (keep an arrow pointing in your
  // reading direction); "Untitled" = name shown for a page with no title.
  'unfinished.title': 'Unfinished tasks',
  'unfinished.sectionLabel': 'Unfinished tasks from previous days',
  'unfinished.empty': 'No unfinished tasks — you\u2019re all caught up!',
  'unfinished.yesterday': 'Yesterday',
  'unfinished.thisWeek': 'This week',
  'unfinished.older': 'Older',
  'unfinished.untitled': 'Untitled',
  'unfinished.breadcrumbArrow': '\u2192',

  // Translators: A Journal day that has no blocks yet: screen-reader-only text and the "+" button
  // that adds the first block (screen-reader label and tooltip); {{date}} = the day's title, a
  // date in the user's chosen format.
  'agenda.day.empty': 'No blocks for {{date}}.',
  'agenda.day.addBlock': 'Add block',

  // Translators: UnfinishedTasks (open tasks from previous days, on today's Journal page): its
  // screen-reader loading text; "{{n}}+" = short count next to the heading when not all are
  // loaded, e.g. "50+"; the two following strings are its screen-reader versions, before and
  // after the section is expanded. Then error lines, and a Retry button with its screen-reader
  // label. {{n}} = tasks loaded.
  'unfinished.loading': 'Loading unfinished tasks',
  'unfinished.countPartial': '{{n}}+',
  'unfinished.countPartialLabel': 'At least {{n}} unfinished tasks — expand to load the rest',
  // #3703 item 1 — the same qualifier for a panel that is ALREADY open, where
  // "expand to load the rest" names an action the listener has already taken.
  'unfinished.countPartialLabelExpanded': 'At least {{n}} unfinished tasks loaded so far',
  'unfinished.loadError': 'Could not load unfinished tasks.',
  'unfinished.partialLoadError': 'Some unfinished tasks could not be loaded.',
  'unfinished.retry': 'Retry',
  'unfinished.retryLabel': 'Retry loading unfinished tasks',
}
