/**
 * i18n namespace: references
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const references: Record<string, string> = {
  'references.headerOne': '1 Reference',
  'references.header': '{{count}} References',
  'references.loadMore': 'Load more',
  'references.loading': 'Loading...',
  'references.loadFailed': 'Failed to load references',
  'references.loadPropertiesFailed': 'Failed to load property keys',
  'references.loadTagsFailed': 'Failed to load tags',
  'references.untitled': 'Untitled',
  'references.empty': '(empty)',
  'references.loadingMore': 'Loading more references',
  'references.loadMoreLabel': 'Load more references',
  'references.backlinksFrom': 'Backlinks from {{title}}',
  'references.linkedBadge': 'Linked',
  'references.unlinkedBadge': 'Unlinked',
  'references.filtersAppliedBadge': '{{count}}',
  'references.filtersAppliedAriaLabel_one': '{{count}} filter applied',
  'references.filtersAppliedAriaLabel_other': '{{count}} filters applied',
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
  'unlinkedRefs.truncated': 'Results truncated — refine search',
  'graph.noPages': 'No pages to visualize',
  'graph.loadFailed': 'Failed to load graph data',
  'graph.title': 'Page Relationships',
  'graph.keyboardHint': 'Use Tab to focus a node, then Enter or Space to open the page.',
  'graph.zoomIn': 'Zoom in',
  'graph.zoomOut': 'Zoom out',
  'graph.zoomReset': 'Fit to view',
  'graph.filterByTag': 'Filter by tag',
  'graph.allPages': 'All pages',
  'graph.filter.addFilter': 'Add filter',
  'graph.filter.addFilterPopoverLabel': 'Add a graph filter',
  'graph.filter.label': 'Filters',
  'graph.filter.noFilters': 'No filters applied',
  'graph.filter.clearAll': 'Clear all',
  'graph.filter.apply': 'Apply',
  'graph.filter.cancel': 'Cancel',
  'graph.filter.selectDimension': 'Select a dimension',
  'graph.filter.filtersApplied': '{{count}} filter applied',
  'graph.filter.filtersApplied_other': '{{count}} filters applied',
  'graph.filter.showingCount': 'Showing {{filtered}} of {{total}} pages',
  'graph.filter.tag': 'Tag',
  'graph.filter.tagPlural': 'Tags',
  'graph.filter.tagNoTags': 'No tags available',
  'graph.filter.status': 'Status',
  'graph.filter.priority': 'Priority',
  'graph.filter.hasDueDate': 'Has due date',
  'graph.filter.hasScheduledDate': 'Has scheduled date',
  'graph.filter.hasBacklinks': 'Has backlinks',
  'graph.filter.excludeTemplates': 'Exclude templates',
  'graph.filter.yes': 'Yes',
  'graph.filter.no': 'No',
  'graph.filter.removeFilter': 'Remove {{label}} filter',
  'graph.filter.statusValue.TODO': 'TODO',
  'graph.filter.statusValue.DOING': 'DOING',
  'graph.filter.statusValue.DONE': 'DONE',
  'graph.filter.statusValue.CANCELLED': 'CANCELLED',
  'graph.filter.priorityValue.1': 'High (1)',
  'graph.filter.priorityValue.2': 'Medium (2)',
  'graph.filter.priorityValue.3': 'Low (3)',
  // UX-7 — search actually fires at 1 char; this is a soft hint (the
  // FTS trigram index matches whole words of 3+ chars best), not a hard
  // requirement, so the copy must not promise a gate that doesn't exist.
  'search.minCharsHint': 'Tip: words of 3+ characters return the best matches.',
  'search.parentPage': 'in: {{title}}',
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
  'backlink.searchTextRequired': 'Search text is required',
  'backlink.propertyKeyRequired': 'Property key is required',
  'backlink.propertyNotFound': 'No blocks have property "{{key}}"',
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
  'backlink.searchTagPlaceholder': 'Search tags...',
  'backlink.noTagsFound': 'No tags found',
  'backlink.selectTag': 'Select tag',
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
  'backlinks.linkMention': 'Link it: replace mention in block {{blockId}}',
  'search.failed': 'Failed to search',
  'search.loadResultsFailed': 'Failed to load search results',
  'search.noParentPage': 'This block has no parent page',
  'search.searchPlaceholder': 'Search blocks...',
  'search.searchLabel': 'Search blocks',
  'search.cjkNoteLabel': 'Note:',
  'search.cjkLimitationNote':
    'CJK search is limited in v1. Some results may be incomplete. Try queries of 3 or more characters for the best matches.',
  'search.recentTitle': 'Recent',
  'search.noResultsFound': 'No results found. Try different keywords or check your spelling.',
  'search.loadingMessage': 'Loading...',
  'search.loadMoreButton': 'Load more',
  'search.resultsCount': '{{count}} results found',
  'search.statusNoResults': 'No results',
  'search.statusCleared': 'Search cleared',
  'search.clearAll': 'Clear all',
  'search.filtersActive': 'Filters active',
  // PEND-54 — inline filter syntax + helper popover.
  'search.addFilter': '+ Filter',
  'search.filterCategory.tag': 'Tag',
  'search.filterCategory.pathInclude': 'Page path (include)',
  'search.filterCategory.pathExclude': 'Page path (exclude)',
  'search.filterCategoryTip': 'Type `tag:` or `path:` directly to skip this menu',
  'search.removeFilter': 'Remove filter {{token}}',
  'search.autocompleteListLabel': 'Filter suggestions',
  'search.invalidGlob': '{{message}}',
  'search.invalidFilter': 'Invalid filter token',
  'search.filterSyntaxIntro':
    'Filter syntax is live — type tag:#name or path:Journal/* in the search input, or use the + Filter button. Press ? for help.',
  'search.searchTags': 'Search tags...',
  'search.searchPages': 'Search pages...',
  'search.noTagsFound': 'No tags found',
  'search.noPagesFound': 'No pages found',
  'search.aliasMatch': 'via alias: {{alias}}',
  // UX-8 — accessible name for the alias-match card region.
  'search.aliasMatchRegion': 'Alias match',
  'search.typing': 'Typing\u2026',
  'search.searching': 'Searching\u2026',
  'tags.addFailed': 'Failed to add tag',
  'tags.deleteFailed': 'Failed to delete tag',
  'tags.createFailed': 'Failed to create tag',
  'references.panelLabel': 'References',
  'unlinkedRefs.panelLabel': 'Unlinked references',
  'linkedReferences.empty': 'No backlinks to this page yet.',
  'unlinkedReferences.empty': 'No unlinked mentions of this page.',
  'backlink.filtersLabel': 'Backlink filters',
  'backlink.appliedFiltersLabel': 'Applied filters',
  'tagList.deleteTagLabel': 'Delete tag',
  'tagList.renameTagLabel': 'Rename tag',
  'tagList.renameInputLabel': 'New tag name',
  'tagList.newTagLabel': 'New tag name',
  'tagList.colorTagLabel': 'Set tag color',
  'tagList.colorPaletteLabel': 'Color palette',
  'tagList.clearColor': 'Clear color',
  'backlink.filtersLegend': 'Backlink filters',
  'backlink.filtersApplied_one': '{{count}} filter applied',
  'backlink.filtersApplied_other': '{{count}} filters applied',
  'search.searchButton': 'Search',
  'tag.addTag': 'Add Tag',
  'batch.selectedCount': '{{count}} selected',
  'unlinkedRefs.listLabel': 'Unlinked reference blocks',
  'search.resultsListLabel': 'Search results',
  'linkedRefs.listLabel': 'Reference blocks',
  'tagList.newTagPlaceholder': 'New tag name...',
  'linkedReferences.errorBoundary': 'Failed to load backlinks for this page.',
  'unlinkedReferences.errorBoundary': 'Failed to load unlinked mentions.',
  'graph.filterBar.errorBoundary': 'Filter bar failed to render.',
  'search.resultsRegionLabel': 'Search results',
  'search.matchCountSingular': '1 match in 1 page',
  'search.matchCountPlural': '{{matchCount}} matches in {{pageCount}} pages',
  'search.matchCountInGroupSingular': '1 match',
  'search.matchCountInGroupPlural': '{{count}} matches',
  /**
   * PEND-50 Phase 1 recommendation: page-name-only hits surface as
   * "1 match (in name)" so users understand why a content-less group
   * appears. Used when a group has exactly one block that is a
   * page-type hit on the title rather than the content.
   */
  'search.matchCountInGroupNameOnly': '1 match (in name)',
  'search.groupCollapsedLabel': 'Show matches in {{pageTitle}}',
  'search.groupExpandedLabel': 'Hide matches in {{pageTitle}}',
  'search.helpButtonLabel': 'Search help',
  // UX-1/UX-3 — search help dialog (structural strings; the dense
  // token reference inside each section is monospace code, not prose).
  'search.help.description': 'Search basics: paginated full-text search across blocks and pages.',
  'search.help.section.filterSyntax': 'Filter syntax',
  'search.help.section.toggles': 'Toggles',
  'search.help.section.regexSyntax': 'Regex syntax',
  'search.help.section.booleanOperators': 'Boolean operators',
  'search.help.section.tips': 'Tips',
  // PEND-55 — toggle row (`Aa` / `Ab|` / `.*`) + search history.
  'search.toggle.caseSensitive': 'Case-sensitive (Aa)',
  'search.toggle.wholeWord': 'Whole word (Ab|)',
  'search.toggle.regex': 'Regex (.*)',
  'search.toggle.toolbarLabel': 'Search modes',
  'search.history.title': 'Recent searches',
  'search.history.empty': 'No recent searches',
  'search.history.clear': 'Clear history',
  'search.history.entryLabel': 'Run search: {{query}}',
  'search.history.removeEntry': 'Remove "{{query}}" from recent searches',
  'search.history.disable': 'Disable search history',
  'search.history.enable': 'Enable search history',
  'search.history.disabledNotice': 'Search history is off',
  'search.filterGroupLabel': 'Filter: {{value}}',
  'search.invalidRegex': '{{message}}',
  // UX-2 — generic (non-regex) search failure: announced in the live
  // region and shown as a visible inline error state.
  'search.statusError': 'Search failed',
  'search.errorTitle': 'Search failed',
  'search.errorBody': 'Something went wrong running your search. Try again.',
  // UX-4 — result cap notice (the 5000-item ceiling was hit silently).
  'search.cappedNotice': 'Showing the first results — refine your search to narrow them down.',
  // PEND-51 — Cmd+K palette dialog.
  'palette.dialogLabel': 'Quick search',
  'palette.dialogTitle': 'Search palette',
  'palette.placeholder': 'Type to search a page or a block…',
  'palette.inputLabel': 'Search pages and blocks',
  'palette.resultsLabel': 'Palette results',
  'palette.recentTitle': 'Recent',
  'palette.titleMatchTag': 'in title',
  'palette.linkModeBadge': 'Linking to page — Enter inserts',
  'palette.noPageMatch': 'No page named “{{query}}”. Type more to refine.',
  'palette.escalateLabel': 'Search in all pages with toggles → Ctrl+Shift+F',
  'palette.groupMatchesLabel': 'Matches in {{pageTitle}}',
  'palette.moreInThisPage_one': '+{{count}} more in this page',
  'palette.moreInThisPage_other': '+{{count}} more in this page',
  // PEND-61 — multi-mode palette (search + commands).
  //
  // PEND-61 CR — `palette.empty` was the catch-all for both the cold-
  // open welcome state and "no results for typed query". Split into
  // `palette.welcomeEmpty` (no query, no recents) + `palette.noResults`
  // (non-empty query, zero matches) so each surface carries the right
  // copy.
  'palette.welcomeEmpty': 'Type to search pages, blocks, or [[ to link. Press > for commands.',
  'palette.noResults': 'No matches for “{{query}}”. Try the escalation below.',
  // PEND-61 CR-2 — footer hint split into per-chord strings so each
  // chord renders as a `<kbd>` chip in the visible UI. Concatenating
  // the chord + label inside one string would put the kbd icon in
  // user-facing translation, which is fragile.
  'palette.footerHintOpen': 'open',
  'palette.footerHintNewTab': 'new tab',
  'palette.footerHintClose': 'close',
  'palette.searching': 'Searching…',
  'palette.commandsPlaceholder': 'Run a command…',
  'palette.modeSearch': 'Search',
  'palette.modeCommands': 'Commands',
  'palette.modeChipLabel': 'Switch palette mode (current: {{mode}})',
  'palette.cmdGroupNavigate': 'Navigate',
  'palette.cmdGroupAction': 'Actions',
  'palette.cmdGoPages': 'Open Pages view',
  'palette.cmdGoTags': 'Open Tags view',
  'palette.cmdGoTrash': 'Open Trash',
  'palette.cmdGoHistory': 'Open History',
  'palette.cmdGoSettings': 'Open Settings',
  'palette.cmdSearchEverywhere': 'Search across all pages…',
  'palette.commandsEmpty': 'No commands match — clear the input to see all.',
  // PEND-67 Phase 2 — recent commands strip rendered above Navigate/Actions
  // when the commands-mode filter is empty.
  'palette.recentCommandsTitle': 'Recent',
  // PEND-67 Phase 3 — `#` (tags) and `?` (help) prefix modes.
  'palette.modeTags': 'Tags',
  'palette.modeHelp': 'Help',
  // Compact hint showing the prefix vocabulary on the search-mode chip
  // row. With three prefixes the long form ("Type > for commands")
  // doesn't fit; we abbreviate to the glyphs.
  'palette.modeHint': '> commands · # tags · ? help',
  // Hint shown when the user is INSIDE a non-search mode — the chip
  // is the way back.
  'palette.modeBackHint': 'Click chip to return to search',
  // Tags mode placeholder + status messages.
  'palette.tagsTitle': 'Tags',
  'palette.tagsWelcomeEmpty': 'Type to filter tags. Enter opens the tag in Search.',
  'palette.tagsNoResults': 'No tags match.',
  'palette.tagsUnnamed': '(unnamed)',
  // Help mode placeholder.
  'palette.helpEmpty': 'No shortcuts match the filter.',
  // PEND-67 Phase 4 — pin / unpin affordance on the recents rows.
  'palette.pinRecent': 'Pin {{title}} to recents',
  'palette.unpinRecent': 'Unpin {{title}} from recents',
  // PEND-67 Phase 5 — per-row action menu labels.
  'palette.actionOpen': 'Open',
  'palette.actionOpenPage': 'Open page',
  'palette.actionOpenNewTab': 'Open in new tab',
  'palette.actionPin': 'Pin to recents',
  'palette.actionUnpin': 'Unpin from recents',
  // PEND-67 Phase 5 follow-up — expanded action sets.
  'palette.actionReveal': 'Reveal in Pages view',
  'palette.actionCopyId': 'Copy page ULID',
  'palette.actionCopyBlockLink': 'Copy block link',
  'palette.actionRemoveFromRecents': 'Remove from recents',
  'palette.copyIdSuccess': 'ULID copied to clipboard',
  'palette.copyLinkSuccess': 'Block link copied to clipboard',
  'palette.copyFailed': 'Could not access clipboard',
  // UX-3 — search help body
  //
  // Prose for the five SearchHelpDialog body sections (Filter syntax,
  // Toggles, Regex syntax, Boolean operators, Tips). Monospace code
  // identifiers (filter prefixes, regex syntax, examples) stay verbatim
  // inside `<mono>…</mono>` tags so they render as code regardless of
  // locale; only the surrounding prose is translatable. Tags map to the
  // inline elements supplied via `<Trans components={{…}}>`.
  // -- Filter syntax --
  'search.help.filter.intro':
    'Filters can be typed directly in the search input or added via the <mono>+ Filter ▾</mono> button. Filters AND-combine with the free-text portion.',
  'search.help.filter.col.token': 'Token',
  'search.help.filter.col.meaning': 'Meaning',
  'search.help.filter.cell.tagName': 'Block carries the tag `name`. Repeats AND.',
  'search.help.filter.cell.bareTag': 'Bare alias for tag:#name.',
  'search.help.filter.cell.path': 'Page-name glob include. Comma-separated values OR-combine.',
  'search.help.filter.cell.notPath': 'Page-name glob exclude.',
  'search.help.filter.cell.state':
    "Block's todo_state = VALUE. Repeats OR-combine. state:none = IS NULL.",
  'search.help.filter.cell.priority':
    "Block's priority = VALUE. Repeats OR-combine. priority:none = IS NULL.",
  'search.help.filter.cell.due':
    'Bucket (today, this-week, overdue, …), ISO date, or comparison form (>=2026-01-01).',
  'search.help.filter.cell.scheduled': 'Same shape as due: but on scheduled_date.',
  'search.help.filter.cell.prop':
    'Block has property KEY with value VALUE. Empty value = key-presence-only.',
  'search.help.filter.cell.notProp': 'Block does NOT have that property/value.',
  'search.help.filter.cell.phrase': 'Quoted phrase — passed to FTS5 verbatim.',
  'search.help.filter.cell.boolean': 'Boolean operators (uppercase) — passed to FTS5.',
  'search.help.filter.datePredicates':
    '<strong>Date predicates</strong>: bucket keywords are <mono>today</mono>, <mono>yesterday</mono>, <mono>overdue</mono>, <mono>this-week</mono>, <mono>this-month</mono>, <mono>next-week</mono>, <mono>older</mono>, <mono>none</mono>. Weeks start on Monday.',
  'search.help.filter.propertyFilters':
    '<strong>Property filters</strong>: <mono>prop:KEY=VALUE</mono> matches a stored property value; an empty value (<mono>prop:KEY=</mono>) matches key-presence only. Property keys are <strong>case-sensitive</strong>.',
  'search.help.filter.globs':
    'Glob filters are <strong>case-insensitive</strong> and match against the page title. A bare token like <mono>path:Journal</mono> wraps to <mono>*Journal*</mono> (substring match); add <mono>*</mono>, <mono>?</mono>, or <mono>[...]</mono> for explicit glob syntax. <mono>{{brace}}</mono> brace-expansion is supported (no nesting).',
  'search.help.filter.examplesIntro': 'Examples:',
  'search.help.filter.example.todo':
    '<mono>TODO path:Journal/2026-* tag:#urgent</mono> — TODOs on January 2026 journal pages tagged urgent.',
  'search.help.filter.example.meeting':
    '<mono>tag:#meeting not-path:Archive/**</mono> — meetings outside the archive.',
  'search.help.filter.example.brace':
    '<mono>path:{{brace}}/*</mono> — match pages in either Journal or Notes.',
  // -- Toggles --
  'search.help.toggles.intro':
    'Three pressable buttons sit to the right of the input. Click a toggle to flip its mode (icon glows when active). State persists across sessions in localStorage.',
  'search.help.toggles.col.icon': 'Icon',
  'search.help.toggles.col.mode': 'Mode',
  'search.help.toggles.col.notes': 'Notes',
  'search.help.toggles.mode.caseSensitive': 'Case-sensitive',
  'search.help.toggles.mode.wholeWord': 'Whole word',
  'search.help.toggles.mode.regex': 'Regex',
  'search.help.toggles.notes.caseSensitive':
    'Forces a post-FTS pass — has a cost even when other toggles are off.',
  'search.help.toggles.notes.wholeWord': 'ASCII-only word boundary. CJK content does not match.',
  'search.help.toggles.notes.regex':
    'Bypasses the FTS index — the free-text remainder becomes a Rust regex pattern; structural filters (tag:, path:, …) still apply.',
  // -- Regex syntax --
  'search.help.regex.intro':
    'Regex mode uses the Rust <mono>regex</mono> crate (linear-time, no backtracking).',
  // The `(?<=…)`, `(?<!…)`, `\k<name>` and `(?u:\b)` code tokens contain
  // angle brackets / backslashes that the `<Trans>` HTML parser would
  // mangle if written as inline text. They are supplied verbatim via
  // self-closing placeholder tags (`<m0/>`, `<m1/>`, …) whose React
  // children carry the literal token; only the surrounding prose is here.
  'search.help.regex.noLookaround':
    '<strong>No lookaround</strong>: <m0/>, <m1/>, <m2/>, <m3/> are not supported.',
  'search.help.regex.noBackrefs':
    '<strong>No backreferences</strong>: <m0/>, <m1/> are not supported.',
  'search.help.regex.asciiBoundaries':
    '<strong>ASCII boundaries by default</strong>: <m0/> only asserts between ASCII word chars. Use <m1/> for Unicode word boundaries.',
  'search.help.regex.inlineFlags':
    'Inline flags <mono>(?i)</mono> / <mono>(?m)</mono> / <mono>(?s)</mono> / <mono>(?x)</mono> are supported.',
  'search.help.regex.caps':
    'Bounded by design: the pattern length, compiled program size, DFA cache, match-offsets per block, and pre-filter row count are all capped (see the regex constants in the backend; the limits are intentionally not duplicated here).',
  'search.help.regex.bypassesFts':
    'Regex mode <strong>bypasses the FTS index</strong>: wall-time scales with the structurally-filtered block count, not the FTS candidate count. Anchor your regex (<mono>^foo</mono>, <mono>bar$</mono>, <mono>\\bword\\b</mono>) for tight queries.',
  // `lnk` (not `link`) is intentional: `<link>` is a void HTML element,
  // so the Trans HTML parser would self-close it and drop the inner text.
  'search.help.regex.seeAlso':
    "See <lnk>Rust regex syntax</lnk> for the full grammar. The in-page find (<mono>Ctrl+F</mono>) uses JavaScript's native <mono>RegExp</mono> instead — patterns may behave differently between the two surfaces; see <mono>docs/SEARCH.md</mono> for the cross-link.",
  // -- Boolean operators --
  'search.help.boolean.intro':
    'Non-regex queries support three FTS5 boolean operators (uppercase on the wire, case-insensitive on input):',
  'search.help.boolean.and': '<mono>AND</mono> — explicit intersection (the default).',
  'search.help.boolean.or': '<mono>OR</mono> — union, e.g. <mono>cats OR dogs</mono>.',
  'search.help.boolean.not': '<mono>NOT</mono> — negation, <mono>meeting NOT cancelled</mono>.',
  'search.help.boolean.phrases':
    'Quoted phrases bypass the trigram length filter: <mono>"sprint plan"</mono> matches the literal phrase including 2-char tokens.',
  'search.help.boolean.regexNote':
    'Boolean operators do NOT apply inside regex mode (everything is treated as the regex).',
  // -- Tips --
  'search.help.tips.recall':
    '<strong>Recall recent queries with</strong> <kbd>↑</kbd> / <kbd>↓</kbd> when the input is empty.',
  'search.help.tips.dedupe':
    'History dedupes — re-submitting the same query moves it to the front.',
  'search.help.tips.perSpace': 'Per-space partitioning — recall stays inside the current space.',
  'search.help.tips.dropdown':
    'The dropdown surfaces the last 20 submitted queries; pressing past the newest entry clears the input.',
  'search.help.tips.clear':
    'Clear the per-space history via the footer button below the dropdown — other spaces stay untouched.',
  'search.help.tips.toggleState': 'Toggle state survives reloads (stored in localStorage).',
}
