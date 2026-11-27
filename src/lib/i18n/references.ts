/**
 * i18n namespace: references
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const references: Record<string, string> = {
  // Translators: References panel under a page (PageEditor) or a journal day: collapsible header of
  // the list of blocks that link to this page. {{count}} = number of linking blocks (2 or more; one
  // has its own key).
  'references.headerOne': '1 reference',
  'references.header': '{{count}} references',

  // Translators: References panel (also the Outgoing links panel): "Load more" button under the
  // list; "Loading..." replaces its text while the next batch loads.
  'references.loadMore': 'Load more',
  'references.loading': 'Loading...',

  // Translators: References panel error messages (toast or inline error card): the list itself, the
  // property keys offered by the filter form, the tags offered by the filter form.
  'references.loadFailed': 'Failed to load references',
  'references.loadPropertiesFailed': 'Failed to load property keys',
  'references.loadTagsFailed': 'Failed to load tags',

  // Translators: References and Outgoing links panels: "Untitled" stands in for a page with no
  // title in a group heading; "(empty)" stands in for a block with no text.
  'references.untitled': 'Untitled',
  'references.empty': '(empty)',

  // Translators: Screen-reader labels (aria-label) of the References panel "Load more" button,
  // while loading and when idle.
  'references.loadingMore': 'Loading more references',
  'references.loadMoreLabel': 'Load more references',

  // Translators: aria-label (screen-reader only) of one page group in the References panel.
  // {{title}} = title of the page whose blocks link here.
  'references.backlinksFrom': 'Backlinks from {{title}}',

  // Translators: Tooltip and aria-label of the chevron button on a reference row (also on a tag's
  // page) that shows or hides the block's child blocks.
  'references.showChildren': 'Show child blocks',
  'references.hideChildren': 'Hide child blocks',

  // #4551 — the link-kind segmented control above the backlink filter builder.
  // Translators: Segmented control above the References and Outgoing links lists: aria-label, then
  // its three short segments. "Page links" = [[page]] links, "Block refs" = ((block)) references.
  'references.kindFilterLabel': 'Filter by link kind',
  'references.kindAll': 'All',
  'references.kindPageLinks': 'Page links',
  'references.kindBlockRefs': 'Block refs',

  // Translators: Small badge beside the References / Unlinked references header: only the number of
  // active filters (keep {{count}} as is), and the screen-reader label that goes with it.
  'references.filtersAppliedBadge': '{{count}}',
  'references.filtersAppliedAriaLabel_one': '{{count}} filter applied',
  'references.filtersAppliedAriaLabel_other': '{{count}} filters applied',

  // ── Outgoing links (#6749) ────────────────────────────────────────
  // Translators: Outgoing links panel under a page (PageEditor): what this page's blocks link to,
  // grouped by target page. Header (also the panel's screen-reader name), empty state, error.
  'outgoingLinks.header': 'Outgoing links',
  'outgoingLinks.empty': 'No block on this page links anywhere.',
  'outgoingLinks.loadFailed': 'Failed to load outgoing links',
  // Translators: Group heading for link targets that no longer resolve (in the Trash, purged or in
  // another space). Short adjective.
  'outgoingLinks.unresolved': 'Unresolved',
  // Translators: aria-label of one group's list; {{title}} = title of the page the links point to.
  'outgoingLinks.listLabel': 'Links to {{title}}',

  // ── Reference count on a referenced block (#6746) ─────────────────
  // Translators: Tooltip and aria-label of the small count chip beside a block that other blocks
  // reference with ((…)); clicking it zooms into the block, which lists the references. {{count}} =
  // number of referencing blocks.
  'refCount.label_one': 'Referenced by {{count}} block — zoom in to list it',
  'refCount.label_other': 'Referenced by {{count}} blocks — zoom in to list them',

  // ── Block-reference peek (#4551) ──────────────────────────────────
  // The chip shows one capped line; the peek shows what it cannot — the
  // target's full content, where it lives, and how many blocks point at it.
  // Translators: Reference peek: small popover that opens on hovering or focusing a ((block
  // reference)) chip and previews the target. Screen-reader labels of the popover and of its
  // location line; {{title}} = the referenced block's or page's title.
  'refPeek.dialogLabel': 'Preview of {{title}}',
  'refPeek.dialogLabelUnknown': 'Block reference preview',
  'refPeek.breadcrumbLabel': 'Location of the referenced block',
  // Translators: Location line in the peek: {{space}} = space name, {{page}} = page title; keep the
  // › separator.
  'refPeek.breadcrumb': '{{space}} › {{page}}',

  // Translators: Reference peek body: loading text, empty target, and the count of blocks that
  // reference the target ({{count}}).
  'refPeek.loading': 'Loading preview…',
  'refPeek.empty': 'This block has no content.',
  'refPeek.references_one': '{{count}} reference',
  'refPeek.references_other': '{{count}} references',

  // Translators: Reference peek buttons: "Open" is the verb (go to the referenced block); "Copy
  // reference" copies the ((…)) reference to the clipboard.
  'refPeek.open': 'Open',
  'refPeek.copyReference': 'Copy reference',

  // Translators: Reference peek messages when the target cannot be shown. {{title}} = the block's
  // title; "Trash" is the app's Trash view.
  'refPeek.deleted': '{{title}} is in the Trash. Restore it from Trash to follow this reference.',
  'refPeek.unresolved':
    'This block is not in the current space. Switch space to follow the reference.',
  'refPeek.error': 'Could not load this block just now.',

  // A `[[page]]` chip peeks on Ctrl/Cmd + hover: the page's title and first blocks.
  // Translators: Same peek for a [[page link]] chip (Ctrl/Cmd + hover): screen-reader label when
  // the title is unknown, then messages shown instead of the page's first blocks.
  'refPeek.pageDialogLabelUnknown': 'Page preview',
  'refPeek.pageEmpty': 'This page is empty.',
  'refPeek.pageNoPreview': 'The first blocks of this page are blank.',
  'refPeek.pageUnresolved':
    'This page is not in the current space. Switch space to follow the link.',
  'refPeek.pageError': 'Could not load this page just now.',

  // ── Embeds (#4550) ────────────────────────────────────────────────
  // `{{embed ((ULID))}}` renders the target's subtree inline. Read-only in
  // phase 1: the two exits are `embed.openSource` and the block-ref chips
  // inside the embedded content.
  // Translators: Embed: a block or page shown inline inside another page. Header strip of the
  // embed. {{page}} = source page title, {{title}} = embedded block title. containerLabel and
  // breadcrumbLabel are screen-reader only; "Open source" is a button (go to the original block).
  'embed.containerLabel': 'Embedded from {{page}}: {{title}}',
  'embed.breadcrumbLabel': 'Embed source',
  'embed.sourcePrefix': 'Embedded from {{page}}',
  'embed.openSource': 'Open source',
  // Translators: aria-label of the chevron button in the embed header.
  'embed.collapse': 'Collapse embed',
  'embed.expand': 'Expand embed',

  // Translators: Embed states. The short texts appear in the header strip; the *Label keys are
  // screen-reader names of the embed. {{title}} = embedded block title. "Restore from Trash" button
  // opens the Trash view; "Unresolved embed" is a very short chip.
  'embed.loading': 'Loading embedded content\u2026',
  'embed.loadingLabel': 'Loading embedded content',
  'embed.sourceDeleted': 'Source deleted',
  'embed.deletedLabel': 'Embedded block deleted: {{title}}',
  'embed.restore': 'Restore from Trash',
  'embed.unresolved': 'Source unavailable',
  'embed.unresolvedLabel': 'Embedded block unavailable',
  'embed.unresolvedChip': 'Unresolved embed',

  // The cycle / depth stubs are real text, not a `::before`, so a screen
  // reader announces where the loop closes.
  // Translators: Shown instead of an embed that would repeat itself (a loop) or nest too deep;
  // followed by a chip naming the block and an "Open source" button.
  'embed.cycleStub': 'Already shown above',
  'embed.depthStub': 'Nested too deep',

  // Translators: Inside an embed: empty states, and a button at the bottom when rows are hidden.
  // {{count}} = number of hidden blocks; "source" = the page that holds the block.
  'embed.emptySource': 'The embedded block has no content.',
  'embed.missingInSource': 'The embedded block is no longer on this page.',
  'embed.showAllInSource_one': '{{count}} more block \u2014 show all in source',
  'embed.showAllInSource_other': '{{count}} more blocks \u2014 show all in source',

  // Translators: Editor picker opened by typing {{ (SuggestionList popup): the item that switches
  // to embed search ("…" = more input follows), and the popup's screen-reader label.
  'embed.pickerItem': 'Insert embed\u2026',
  'embed.pickerHeader': 'Embed a block or page',

  // Phase 2 \u2014 edit in place, behind a per-embed unlock that is never
  // persisted. The hint is permanent rather than a toast fired on a blocked
  // chord: the restriction is a property of the region, so it belongs beside
  // the state that created it.
  // Translators: Editing an embed in place: aria-label of the lock toggle in the embed header,
  // header strip text while editing ({{page}} = source page title), hint line under the header
  // (only text can change; restructure on the source page), and a live announcement.
  'embed.unlock': 'Edit this embed in place',
  'embed.lock': 'Stop editing this embed',
  'embed.editingPrefix': 'Editing {{page}}',
  'embed.editHint': 'Text edits only \u2014 open the source to restructure',
  'embed.unlockedAnnouncement': 'Editing {{page}} in place. Text edits only.',

  // Translators: Unlinked references panel under a page (PageEditor): blocks that mention this
  // page's title as plain text, without a [[link]]. Header; {{count}} = number of such blocks (2 or
  // more).
  'unlinkedRefs.headerNone': 'No unlinked references',
  'unlinkedRefs.headerOne': '1 unlinked reference',
  'unlinkedRefs.header': '{{count}} unlinked references',

  // Translators: Button on each Unlinked references row that turns the mention into a [[link]].
  // Short verb phrase.
  'unlinkedRefs.linkIt': 'Link it',

  // Translators: Unlinked references panel: "Load more" button; "Loading…" while the panel first
  // loads; "Loading..." on the button while the next batch loads.
  'unlinkedRefs.loadMore': 'Load more',
  'unlinkedRefs.loading': 'Loading\u2026',
  'unlinkedRefs.loadingDots': 'Loading...',

  // Translators: Unlinked references panel errors: loadFailed is the open panel's inline alert, or a
  // toast while the panel is collapsed; linkFailed is a toast after "Link it" fails.
  'unlinkedRefs.loadFailed': 'Failed to load unlinked references',
  'unlinkedRefs.linkFailed': 'Failed to link reference',

  // Translators: Unlinked references panel: empty state; "Untitled" stands in for a page with no
  // title; "(empty)" for a block with no text.
  'unlinkedRefs.noResults': 'No unlinked references found.',
  'unlinkedRefs.untitled': 'Untitled',
  'unlinkedRefs.empty': '(empty)',

  // Translators: Unlinked references panel: screen-reader labels of the "Load more" button, a page
  // group's aria-label ({{title}} = page title), and a note under the list when the results were
  // cut off.
  'unlinkedRefs.loadingMore': 'Loading more unlinked references',
  'unlinkedRefs.loadMoreLabel': 'Load more unlinked references',
  'unlinkedRefs.mentionsFrom': 'Unlinked mentions from {{title}}',
  'unlinkedRefs.truncated': 'Results truncated — refine search',

  // Translators: Graph view (page-relationship graph): empty states and error messages;
  // tagsLoadFailed is a toast about the tags offered by the tag filter.
  'graph.noPages': 'No pages to visualize',
  'graph.noMatches': 'No pages match the current filters',
  'graph.loadFailed': 'Failed to load graph data',
  'graph.tagsLoadFailed': 'Failed to load tags for the filter',

  // Translators: Graph view: screen-reader name of the graph canvas and its screen-reader-only
  // usage hint (Tab, Arrow, Space, Enter, Escape are keyboard keys); "selected" is a live
  // announcement, {{page}} = page title.
  'graph.title': 'Page relationships',
  'graph.keyboardHint':
    'Use Tab to enter the graph, then Arrow keys or typing a name to move between nodes. Space or a click selects a node; Enter or a second click opens its page; Escape clears the selection.',
  'graph.selected': 'Selected "{{page}}"',

  // Translators: Graph view: tooltips and aria-labels of the zoom buttons; also listed as shortcut
  // names in Settings › Keyboard.
  'graph.zoomIn': 'Zoom in',
  'graph.zoomOut': 'Zoom out',
  'graph.zoomReset': 'Fit to view',

  // Translators: Graph view tag filter: label of the tag selector and its option that shows every
  // page.
  'graph.filterByTag': 'Filter by tag',
  'graph.allPages': 'All pages',

  // Local-graph mode (#1429) — per-page "focus on this page" neighborhood.
  // Translators: Graph view, local-graph control: toggle button that shows only the pages around
  // the open page, its exit, the status text, and a button back to the page focus started from.
  // {{page}} = page title.
  'graph.local.focus': 'Focus on this page',
  'graph.local.exit': 'Exit focus',
  'graph.local.active': 'Showing neighbors of "{{page}}"',
  'graph.local.back': 'Back to "{{page}}"',
  // Translators: Why the toggle is disabled, shown from the (i) button beside it, and toast from
  // the Command palette "Show this page in graph" command; noPageInfo = that (i) button's
  // screen-reader label.
  'graph.local.noPage': 'Open a page to focus the graph on it',
  'graph.local.noPageInfo': 'Why focus is unavailable',
  // Translators: Empty-state message over the graph in local mode; {{page}} = page title.
  'graph.local.seedHidden': '"{{page}}" is hidden by the active filters',
  'graph.local.seedIsTag': '"{{page}}" is a tag, and the graph shows only pages',
  // Translators: Neighborhood depth selector. A "hop" is one link step between pages. depthOption
  // is the aria-label of each number button ({{count}} = 1, 2 or 3); depthGroupLabel names the
  // button group.
  'graph.local.depthLabel': 'Hops',
  'graph.local.depthOption_one': '{{count}} hop',
  'graph.local.depthOption_other': '{{count}} hops',
  'graph.local.depthGroupLabel': 'Neighborhood depth',

  // Translators: Graph view filter bar: "Add filter" button (also the bar's screen-reader name) and
  // its popover, the "Filters" label at the start of the bar, a chip shown when no filter is set,
  // and the popover's buttons and dimension dropdown.
  'graph.filter.addFilter': 'Add filter',
  'graph.filter.addFilterPopoverLabel': 'Add a graph filter',
  'graph.filter.clearAll': 'Clear all',
  'graph.filter.apply': 'Apply',
  'graph.filter.cancel': 'Cancel',
  'graph.filter.selectDimension': 'Select a dimension',

  // Translators: Graph filter bar: live announcement of the number of filters ({{count}}), and
  // notices at the end of the bar: {{filtered}} of {{total}} pages shown; {{shown}} of {{total}}
  // links drawn when a large graph is cut down. backlinksUnavailableTruncated follows
  // edgesTruncated in the same notice.
  'graph.filter.filtersApplied_one': '{{count}} filter applied',
  'graph.filter.filtersApplied_other': '{{count}} filters applied',
  'graph.filter.showingCount': 'Showing {{filtered}} of {{total}} pages',
  // #2298 count-then-cap — the backend edge cap fired; the graph renders
  // a partial edge set and says so instead of truncating silently.
  'graph.filter.edgesTruncated': 'Showing {{shown}} of {{total}} links — large graph truncated',
  // #3314 finding 3 — sibling of `edgesTruncated`: when the edge cap fires
  // the backend drops the weakest edges first, so per-node backlink counts
  // (and therefore the "Has backlinks" filter dimension) are unreliable
  // too, not just the raw edge count. Rendered alongside `edgesTruncated`.
  'graph.filter.backlinksUnavailableTruncated':
    'Backlink counts are unavailable while the graph is truncated.',

  // Translators: Graph filter types: options of the dimension dropdown, legends of their forms and
  // filter chip labels. On a chip the code adds ": " and the chosen values (e.g. "Status: TODO,
  // DONE", "Has due date: Yes"); Yes/No are those values.
  'graph.filter.tag': 'Tag',
  'graph.filter.tagPlural': 'Tags',
  'graph.filter.tagNoTags': 'No tags available',
  'graph.filter.status': 'Status',
  'graph.filter.priority': 'Priority',
  'graph.filter.hasDueDate': 'Has due date',
  'graph.filter.hasScheduledDate': 'Has scheduled date',
  'graph.filter.hasBacklinks': 'Has backlinks',
  'graph.filter.excludeTemplates': 'Exclude templates',
  'graph.filter.excludeJournal': 'Exclude journal pages',
  'graph.filter.yes': 'Yes',
  'graph.filter.no': 'No',
  // Translators: aria-label of a chip's remove button; {{label}} = the chip text, e.g. "Status:
  // TODO".
  'graph.filter.removeFilter': 'Remove {{label}} filter',

  // Translators: Graph Status filter: checkbox labels for the task states. These are the task
  // keywords written in blocks; keep them identical to the editor's keywords (normally left in
  // English).
  'graph.filter.statusValue.TODO': 'TODO',
  'graph.filter.statusValue.DOING': 'DOING',
  'graph.filter.statusValue.DONE': 'DONE',
  'graph.filter.statusValue.CANCELLED': 'CANCELLED',

  // Translators: Graph Priority filter: checkbox labels; the number in parentheses is the priority
  // level written in blocks, keep it.
  'graph.filter.priorityValue.1': 'High (1)',
  'graph.filter.priorityValue.2': 'Medium (2)',
  'graph.filter.priorityValue.3': 'Low (3)',

  // Translators: Search result: the page the block is on; {{title}} = page title.
  'search.parentPage': 'in: {{title}}',

  // Translators: Tags view (and tag pickers) error and success toasts. "deep-work" is an example
  // tag name: it may be localized but must stay hyphenated, without spaces. renameFailed is
  // followed by ": " and a technical error.
  'tags.loadFailed': 'Failed to load tags',
  'tags.nameTooLong': 'Tag name must be under 100 characters',
  'tags.duplicateName': 'A tag with that name already exists.',
  'tags.nameHasWhitespace': "A tag name can't contain spaces. Use - instead, as in deep-work.",
  'tags.renameSuccess': 'Tag renamed successfully.',
  'tags.renameFailed': 'Failed to rename tag',

  // Translators: Tags view: Rename tag dialog title, body text and input placeholder.
  'tags.renameTitle': 'Rename tag',
  'tags.renameDescription': 'Enter a new name for this tag.',
  'tags.renamePlaceholder': 'Tag name',

  // Translators: Tags view: delete confirmation dialog (ConfirmDialog). {{name}} = tag name.
  // Confirm and Cancel buttons.
  'tags.deleteTitle': 'Delete tag?',
  'tags.deleteDescription':
    'This will delete the tag “{{name}}”. This action cannot be undone. Blocks using this tag will lose the reference.',
  'tags.deleteConfirm': 'Delete',
  'tags.deleteCancel': 'Cancel',

  // Translators: Tags view: empty state of the tag list; "above" is the new-tag field at the top of
  // the view.
  'tagList.empty': 'No tags yet. Create one above to organize your blocks.',

  // Translators: A tag's own page (opened by clicking a tag): sections listing the pages and the
  // blocks that carry the tag. Section headings, a block list's aria-label ({{title}} = page
  // title), empty states, error.
  'taggedItems.pages': 'Pages',
  'taggedItems.blocks': 'Blocks',
  'taggedItems.blocksIn': 'Blocks in {{title}}',
  'taggedItems.noPages': 'No pages have this tag.',
  'taggedItems.noBlocks': 'No blocks have this tag.',
  'taggedItems.loadFailed': 'Failed to load what this tag is on.',

  // Translators: A tag's own page, an expanded block: shown when it has no child blocks, or when
  // some are hidden ({{count}} = hidden blocks).
  'taggedItems.noChildren': 'No child blocks.',
  'taggedItems.moreChildren_one': '{{count}} more block \u2014 open the block to see it',
  'taggedItems.moreChildren_other': '{{count}} more blocks \u2014 open the block to see them',

  // Translators: A tag's own page: link button that opens Search on everything under the tag,
  // including blocks that inherit it. {{name}} = tag name; keep the # before it.
  'taggedItems.searchUnder': 'Search everything under #{{name}}',

  // Translators: A tag's own page: the section holding the notes written on the tag (the blocks of
  // its page "Tag/<name>"). Section heading, the hint and the button shown before any note exists,
  // error toasts.
  'tagNotes.title': 'Notes',
  'tagNotes.empty': 'Nothing is written on this tag yet.',
  'tagNotes.add': 'Add notes',
  'tagNotes.createFailed': 'Failed to start the notes of this tag',
  'tagNotes.loadFailed': 'Failed to load the notes of this tag',

  // Translators: A page titled "Tag/<name>" holds the notes of the tag <name>: link button under
  // its title that opens the tag. {{name}} = tag name; keep the # before it.
  'tagNotes.openTag': 'Notes of the tag #{{name}}',

  // Translators: Error when a page is created with a title starting "Tag/", renamed into such a
  // title, or a tag's notes page renamed out of it: those pages are made by their tag. Keep "Tag/" as
  // it is, it is the literal start of the title.
  'tags.pageTitleReserved':
    'Pages under "Tag/" belong to their tags. Create or rename the tag instead.',

  // Translators: Toast after a typed link [[Tag/<name>]] whose name held spaces made the tag with
  // dashes instead, and the page titled with them. {{title}} = the page title made, e.g.
  // "Tag/deep-work".
  'tags.linkPageDashed': 'Linked {{title}}: a tag name holds no spaces',

  // Translators: Error when renaming a tag or its notes page "Tag/<name>": the two are renamed
  // together, and another page or tag already has the new name.
  'tags.pageTitleTaken':
    'A tag and its notes page are renamed together, and another page or tag already has that name. Rename or delete it first.',

  // Translators: References panel › Add filter row: error toasts when a filter cannot be applied.
  // {{key}} = the property key typed. "after"/"before" are the two date fields; YYYY-MM-DD is the
  // required date format (ISO).
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

  // Translators: References panel filter bar: "Add filter" button (also the add row's aria-label),
  // the category dropdown's aria-label and placeholder, then its options. "Block Type" = page, text
  // block or tag; "Contains" = text search; "Tag Prefix" = tags starting with some text.
  'backlink.addFilterLabel': 'Add filter',
  'backlink.filterCategoryLabel': 'Filter category',
  'backlink.selectFilter': 'Select filter...',
  'backlink.typeOption': 'Block type',
  'backlink.statusOption': 'Status',
  'backlink.priorityOption': 'Priority',
  'backlink.containsOption': 'Contains',
  'backlink.propertyOption': 'Property',
  'backlink.createdDateOption': 'Created date',
  'backlink.propertyIsSetOption': 'Property is set',
  'backlink.propertyIsEmptyOption': 'Property is empty',
  'backlink.hasTagOption': 'Has tag',
  'backlink.tagPrefixOption': 'Tag prefix',

  // Translators: Add filter row, Block Type form: dropdown aria-label and options; "Content" = an
  // ordinary text block (not a page or a tag).
  'backlink.blockTypeValueLabel': 'Block type value',
  'backlink.contentType': 'Content',
  'backlink.pageType': 'Page',
  'backlink.tagType': 'Tag',

  // Translators: Add filter row, Status form: dropdown aria-label and task-state options.
  // TODO/DOING/DONE are task keywords written in blocks (normally left in English).
  'backlink.statusValueLabel': 'Status value',
  'backlink.todoStatus': 'TODO',
  'backlink.doingStatus': 'DOING',
  'backlink.doneStatus': 'DONE',

  // Issue #1647 follow-up — the SINGLE canonical task-state vocabulary,
  // shared by the search "State" builder form and the backlink "Status"
  // category form (see components/filters/forms/stateVocabulary.ts). One
  // label set so the two surfaces can never drift.
  // Translators: Task-state choices in the References panel Status filter and in Search › Add
  // filter › State. TODO… are the task keywords written in blocks (normally left in English);
  // "None" = no task state (also "no priority" in the Priority filter).
  'filterState.todo': 'TODO',
  'filterState.doing': 'DOING',
  'filterState.done': 'DONE',
  'filterState.cancelled': 'CANCELLED',
  'filterState.none': 'None',

  // Translators: Add filter row, Priority form: dropdown aria-label and options; the number in
  // brackets is the priority level, keep it.
  'backlink.priorityValueLabel': 'Priority value',
  'backlink.highPriority': 'High [1]',
  'backlink.mediumPriority': 'Medium [2]',
  'backlink.lowPriority': 'Low [3]',

  // Translators: Add filter row, Contains form: text input placeholder and aria-label.
  'backlink.searchTextPlaceholder': 'Search text...',
  'backlink.containsTextLabel': 'Contains text',

  // Translators: Add filter row, property forms: aria-labels and placeholders. "key" and "value"
  // are lowercase placeholders inside inputs; the type options set how the value is compared (as
  // text, number or date).
  'backlink.propertyKeyLabel': 'Property key',
  'backlink.keyPlaceholder': 'key',
  'backlink.comparisonOpLabel': 'Comparison operator',
  'backlink.propertyTypeLabel': 'Property type',
  'backlink.textType': 'Text',
  'backlink.numberType': 'Number',
  'backlink.dateType': 'Date',
  'backlink.valuePlaceholder': 'value',

  // Translators: Add filter row, Created Date form: aria-labels of the two date inputs; "to" is the
  // short lowercase word between them.
  'backlink.dateAfterLabel': 'Date after',
  'backlink.dateTo': 'to',
  'backlink.dateBeforeLabel': 'Date before',

  // Translators: Add filter row, tag forms: field labels (screen-reader).
  'backlink.tagLabel': 'Tag',
  'backlink.tagPrefixLabel': 'Tag prefix',

  // Translators: Add filter row: Apply and Cancel buttons; the *Label keys are their screen-reader
  // labels.
  'backlink.applyFilterLabel': 'Apply filter',
  'backlink.applyButton': 'Apply',
  'backlink.cancelAddingFilterLabel': 'Cancel adding filter',
  'backlink.cancelButton': 'Cancel',

  // Translators: References panel: toast when the same filter is added twice.
  'backlink.filterAlreadyApplied': 'Filter already applied',

  // Translators: Add filter row form controls: property value aria-label, Tag Prefix placeholder,
  // and the Has Tag picker (search placeholder, empty result, button text before a tag is chosen).
  'backlink.propertyValueLabel': 'Property value',
  'backlink.tagPrefixPlaceholder': 'Tag prefix...',
  'backlink.searchTagPlaceholder': 'Search tags...',
  'backlink.noTagsFound': 'No tags found',
  'backlink.selectTag': 'Select tag',

  // Translators: References panel filter bar: button that removes every filter and the sort
  // (aria-label, then visible text).
  'backlink.clearAllLabel': 'Clear all filters and sort',
  'backlink.clearAllButton': 'Clear all',

  // Translators: References panel sort control: aria-labels, the short "Sort:" prefix before the
  // current field, dropdown section headings (built-in fields vs the user's own property names),
  // and the built-in fields. "Completed" = completion date.
  'backlink.sortGroupLabel': 'Sort references',
  'backlink.sortByLabel': 'Sort by',
  'backlink.sortPrefix': 'Sort:',
  'backlink.sortGroupBuiltin': 'Built-in',
  'backlink.sortGroupProperties': 'Your properties',
  'backlink.sortCreated': 'Created',
  'backlink.sortDue': 'Due date',
  'backlink.sortScheduled': 'Scheduled',
  'backlink.sortPriority': 'Priority',
  'backlink.sortCompleted': 'Completed',
  // Translators: Tooltip and aria-label of the sort direction button; {{direction}} = "ascending"
  // or "descending" (lowercase).
  'backlink.sortDirectionLabel': 'Sorted {{direction}}, click to reverse',

  // Translators: References panel: line under the filter bar while filters are active; {{filtered}}
  // = blocks shown, {{total}} = all linking blocks.
  'backlink.showingCount': 'Showing {{filtered}} of {{total}} backlinks',

  // Translators: aria-label of the "Link it" button on an Unlinked references row; {{text}} = the
  // start of the block's text.
  'backlinks.linkMention': 'Link it: {{text}}',

  // Translators: Error toasts: a search request failed (Command palette, suggestions); opening a
  // Search result failed to load its page; the clicked result is not on any page.
  'search.failed': 'Failed to search',
  'search.loadResultsFailed': 'Failed to load search results',
  'search.noParentPage': 'This block has no parent page',

  // Translators: Search view input: placeholder (normal and regex mode), aria-label, and the
  // screen-reader description in regex mode. tag: and path: are filter syntax and must stay as
  // written.
  'search.searchPlaceholder': 'Search blocks...',
  'search.searchPlaceholderRegex': 'Search with a regular expression...',
  'search.searchLabel': 'Search blocks',
  'search.regexModeHint':
    'Free-text is matched as a regular expression. Filters like tag: and path: still apply.',

  // Translators: Search view: heading above the recently opened pages, shown while the input is
  // empty.
  'search.recentTitle': 'Recent',

  // Translators: Search view: empty state headline and description when nothing matches.
  'search.noResultsHeadline': 'No results',
  'search.noResultsFound': 'No results found. Try different keywords or check your spelling.',

  // #3315 item 1 — regex mode scans only a bounded window of the newest blocks,
  // so an empty regex result set does NOT mean the pattern is absent from the
  // vault. Deliberately quotes no row count: the bound is a backend constant
  // (`REGEX_PRE_FILTER_CAP`) and a number duplicated here would drift.
  // Translators: Search view in regex mode: empty-state description, and an info box shown while
  // regex mode is on. tag: and path: are filter syntax and must stay as written.
  'search.noResultsRegexScope':
    'No matches in the scanned range. Regex search only scans your most recent blocks, so older matches are not looked at — add a tag: or path: filter to narrow the scan.',
  'search.regexScopeNotice':
    'Regex search scans only your most recent blocks. Matches in older blocks are not included — add a tag: or path: filter to narrow the scan.',

  // Translators: Search view: button in the empty state that removes all filter chips.
  'search.clearFilters': 'Clear filters',

  // Translators: Search view: loading text and the "Load more" button under the results.
  'search.loadingMessage': 'Loading...',
  'search.loadMoreButton': 'Load more',

  // Translators: Search view live announcements (screen reader only) after a search; {{count}} =
  // number of results.
  'search.resultsCount_one': '{{count}} result found',
  'search.resultsCount_other': '{{count}} results found',
  'search.statusNoResults': 'No results',
  'search.statusCleared': 'Search cleared',

  // Translators: Search view filter chip row: link-style button at its end that removes every chip,
  // and the row's screen-reader name.
  'search.clearAll': 'Clear all',
  'search.filtersActive': 'Filters active',

  // Inline filter syntax + helper popover.
  // Translators: Search view: "Add filter" button beside the input and its popover. The categories
  // are menu items, each shown beside example syntax (tag:#name, path:Journal/*, …), and headings
  // of their forms. In the tip, `tag:` and `path:` are syntax: keep them and the backticks.
  'search.addFilter': 'Add filter',
  'search.filterCategory.tag': 'Tag',
  'search.filterCategory.pathInclude': 'Page path (include)',
  'search.filterCategory.pathExclude': 'Page path (exclude)',
  // Structural filter builder categories.
  'search.filterCategory.state': 'State',
  'search.filterCategory.priority': 'Priority',
  'search.filterCategory.due': 'Due date',
  'search.filterCategory.scheduled': 'Scheduled date',
  'search.filterCategory.prop': 'Property',
  'search.filterCategoryTip': 'Type `tag:` or `path:` directly to skip this menu',

  // Translators: Search view: aria-label of a filter chip's remove button; {{token}} = the chip
  // text, e.g. "tag:#work".
  'search.removeFilter': 'Remove filter {{token}}',

  // Translators: Search view: screen-reader name of the suggestion list under the input.
  'search.autocompleteListLabel': 'Filter suggestions',

  // Translators: Search view, invalid filter chip. invalidGlob only passes {{message}} (an error
  // text) through: keep it as is.
  'search.invalidGlob': '{{message}}',
  'search.invalidFilter': 'Invalid filter token',
  // Accessible name for an invalid filter chip — carries the parser error so
  // screen-reader users get the reason, not just "invalid".
  // Translators: Screen-reader name of an invalid chip, and one line of the error text under the
  // chips (several are joined with "; "). {{label}} = chip text; {{error}} = the reason
  // (searchQuery.* keys).
  'search.invalidFilterWithError': 'Invalid filter: {{label}} — {{error}}',
  // One line per invalid chip in the shared row-level alert region.
  'search.invalidFilterError': '{{label}}: {{error}}',

  // #4555 — parser-level validation strings from `search-query/register.ts`.
  // `{{prefix}}`/`{{noun}}` carry search-DSL glossary tokens (`tag:`,
  // `state:`, `prop`, …) verbatim — per #4555 §1.5 these tokens are NEVER
  // translated (queries are persisted verbatim and sync across devices), so
  // only the surrounding sentence is localized.
  // Translators: Search query errors for an invalid filter chip, inserted as {{error}} after the
  // chip text and a colon, so they start lowercase. tag:, under:, #tag, OR, NOT, not-, key=value
  // and YYYY-MM-DD are literal query syntax: keep them as written. {{prefix}} = a filter prefix
  // such as "path:" or "prop" (literal); {{value}} = what the user typed (unknownState after
  // state:, unknownPriority after priority:); {{op}} = an operator such as ">="; {{rest}} = the
  // text after it.
  'searchQuery.valueRequired': '{{prefix}} value required',
  'searchQuery.unknownState': "unknown state '{{value}}'",
  'searchQuery.unknownPriority': "unknown priority '{{value}}'",
  'searchQuery.dateExpectedAfterOperator': "expected YYYY-MM-DD after '{{op}}', got '{{rest}}'",
  'searchQuery.unknownDate': "unknown date '{{value}}'",
  'searchQuery.propKeyValueRequired': '{{prefix}}: key=value required',
  'searchQuery.propExpectedKeyEqualsValue': "{{prefix}}: expected 'key=value'",
  'searchQuery.propKeyEmpty': '{{prefix}}: key cannot be empty',
  'searchQuery.tagBesideUnder':
    'tag: and #tag cannot be combined with under:; use under: for every tag',
  'searchQuery.unbalancedParen': 'this parenthesis has no partner',
  'searchQuery.orMissingSide': 'OR needs a filter on each side',
  'searchQuery.textBesideFilterOr':
    'free text cannot be part of an OR of filters or a group of them; put the filters, or all the words, in parentheses of their own',
  'searchQuery.wordGroupNotAlone': 'words in parentheses must be every word of the query',
  'searchQuery.notBeforeFilter': 'NOT cannot negate a filter; use its not- form',
  'searchQuery.emptyGroup': 'empty parentheses',

  // Translators: Search view: hint line under the search field. tag:#name and path:Journal/* are
  // syntax (keep); "Add filter" names the button. filterHelpKey follows it where there is a
  // keyboard; ? is the key that opens help.
  'search.filterSyntaxIntro': 'Filter with tag:#name or path:Journal/*, or use Add filter.',
  'search.filterHelpKey': 'Press ? for help.',

  // Translators: Search › Add filter popover, tag and page pickers: search placeholders and empty
  // results.
  'search.searchTags': 'Search tags...',
  'search.searchPages': 'Search pages...',
  'search.noTagsFound': 'No tags found',

  // Filter-helper popover navigation + path-entry strings.
  // Translators: Search › Add filter popover forms: "Back" returns to the category menu, "Add" adds
  // the filter; the tag list's screen-reader name; an example page-path pattern as placeholder
  // (keep it exactly as written: it matches the path: examples in the search help).
  'search.filterHelper.back': 'Back',
  'search.filterHelper.add': 'Add',
  'search.filterHelper.tagResultsLabel': 'Tag suggestions',
  'search.filterHelper.pathPlaceholder': 'Journal/2026-*',

  // Structural filter builder form strings.
  // Translators: Search › Add filter forms (State, Priority, Due/Scheduled date, Property).
  // Include/Exclude toggle: keep or drop the matching blocks. Date forms choose a "Named range"
  // (today, this-week, …) or a "Comparison" (operator + date). Most *Label keys are screen-reader
  // labels.
  'search.filterHelper.matchMode': 'Match mode',
  'search.filterHelper.include': 'Include',
  'search.filterHelper.exclude': 'Exclude',
  'search.filterHelper.stateValueLabel': 'State value',
  'search.filterHelper.priorityValueLabel': 'Priority value',
  'search.filterHelper.dateShapeLabel': 'Date filter shape',
  'search.filterHelper.dateShapeBucket': 'Named range',
  'search.filterHelper.dateShapeOp': 'Comparison',
  'search.filterHelper.dateBucketLabel': 'Named date range',
  'search.filterHelper.dateOpLabel': 'Comparison operator',
  'search.filterHelper.dateValueLabel': 'Date',
  'search.filterHelper.dateInvalid': 'Enter a valid date (YYYY-MM-DD)',
  'search.filterHelper.propKeyLabel': 'Property key',
  // Translators: Example property key in an empty input; may be localized.
  'search.filterHelper.propKeyPlaceholder': 'area',
  'search.filterHelper.propValueLabel': 'Property value',
  'search.filterHelper.propValuePlaceholder': 'value',
  // Round-trip guards: the forms reject keys/values
  // they can't serialise back unambiguously. #152 added value quoting, so
  // spaces are fine in VALUES; a literal `"` still has no escape syntax.
  // Translators: Inline validation errors; = and quotes are literal characters. "Glob" = a
  // page-name pattern with * wildcards.
  'search.filterHelper.propKeyInvalid': "Key can't contain spaces, = or quotes",
  'search.filterHelper.propValueInvalid': "Value can't contain quotes",
  // #718 — same rule for the path-glob form (globs quote like prop values).
  'search.filterHelper.pathValueInvalid': "Glob can't contain quotes",

  // Translators: Search › Add filter: page picker empty result.
  'search.noPagesFound': 'No pages found',

  // Translators: Search view: line on a result card when the query matched a page alias ({{alias}}
  // = the alias), and the card's screen-reader name.
  'search.aliasMatch': 'via alias: {{alias}}',
  // Accessible name for the alias-match card region.
  'search.aliasMatchRegion': 'Alias match',

  // Translators: Search view: indicators beside the input while the user types and while the search
  // runs; "Searching…" is also a live announcement.
  'search.typing': 'Typing\u2026',
  'search.searching': 'Searching\u2026',

  // Translators: Error toasts: adding a tag to a block failed; removing a tag from a block, or
  // deleting a tag in the Tags view, failed; creating a tag failed.
  'tags.addFailed': 'Failed to add tag',
  'tags.deleteFailed': 'Failed to delete tag',
  'tags.createFailed': 'Failed to create tag',

  // Translators: Screen-reader names of the References and Unlinked references panels (References
  // is also shown as the header during the first load).
  'references.panelLabel': 'References',
  'unlinkedRefs.panelLabel': 'Unlinked references',

  // Translators: Empty states of the References and Unlinked references panels under a page.
  'linkedReferences.empty': 'No backlinks to this page yet.',
  'unlinkedReferences.empty': 'No unlinked mentions of this page.',

  // Translators: References panel: screen-reader names of the filter area and of the list of active
  // filter chips.
  'backlink.filtersLabel': 'Backlink filters',
  'backlink.appliedFiltersLabel': 'Applied filters',

  // Translators: Tags view, a tag row: aria-labels of the delete and rename icon buttons, the
  // rename dialog input, the new-tag input at the top, the color swatch button and its preset
  // group.
  'tagList.deleteTagLabel': 'Delete tag',
  'tagList.renameTagLabel': 'Rename tag',
  'tagList.renameInputLabel': 'New tag name',
  'tagList.newTagLabel': 'New tag name',
  'tagList.colorTagLabel': 'Set tag color',
  'tagList.colorPaletteLabel': 'Color palette',

  // One per `TAG_COLOR_PRESETS` name (`src/lib/tag-colors.ts`).
  // Translators: Tags view color picker: aria-labels of the preset color swatches (color names).
  'tagList.color.emerald': 'Emerald',
  'tagList.color.blue': 'Blue',
  'tagList.color.violet': 'Violet',
  'tagList.color.amber': 'Amber',
  'tagList.color.rose': 'Rose',
  'tagList.color.slate': 'Slate',
  'tagList.color.orange': 'Orange',

  // Translators: Tags view color picker: a toggle that shows the custom color picker, the label of
  // its hex color field, the error shown under that field for a value that is not a hex color, and a
  // button that removes the tag's color.
  'tagList.customColorLabel': 'Custom color',
  'tagList.hexColorLabel': 'Hex color',
  'tagList.hexColorInvalid': 'Enter a hex color, like #3b82f6',
  'tagList.clearColor': 'Clear color',

  // Translators: References panel filters: screen-reader legend, and a live announcement of the
  // number of filters ({{count}}).
  'backlink.filtersLegend': 'Backlink filters',
  'backlink.filtersApplied_one': '{{count}} filter applied',
  'backlink.filtersApplied_other': '{{count}} filters applied',

  // Translators: Search view: submit button beside the input (verb).
  'search.searchButton': 'Search',

  // Translators: Tags view: button beside the new tag name field.
  'tag.addTag': 'Add tag',

  // Translators: Batch toolbar (Pages view, Trash, History) when rows are multi-selected: badge and
  // screen-reader label; {{count}} = selected rows.
  'batch.selectedCount': '{{count}} selected',

  // Translators: Screen-reader names of result lists: Unlinked references, Search, References.
  'unlinkedRefs.listLabel': 'Unlinked reference blocks',
  'search.resultsListLabel': 'Search results',
  'linkedRefs.listLabel': 'Reference blocks',

  // Translators: Tags view: placeholder of the new tag name field.
  'tagList.newTagPlaceholder': 'New tag name...',

  // Translators: Shown in place of a section that crashed: the References panel, the Unlinked
  // references panel, the Graph view filter bar.
  'linkedReferences.errorBoundary': 'Failed to load backlinks for this page.',
  'unlinkedReferences.errorBoundary': 'Failed to load unlinked mentions.',
  'graph.filterBar.errorBoundary': 'Filter bar failed to render.',

  // Translators: Search view: screen-reader name of the results area.
  'search.resultsRegionLabel': 'Search results',

  // Translators: Search view: summary line above the results; {{count}} = matching blocks;
  // {{pages}} = the search.pageCount text (e.g. "3 pages"). The *InGroup* keys are the small count
  // beside each page group heading.
  'search.matchCount_one': '{{count}} match in {{pages}}',
  'search.matchCount_other': '{{count}} matches in {{pages}}',
  'search.pageCount_one': '{{count}} page',
  'search.pageCount_other': '{{count}} pages',
  'search.matchCountInGroupSingular': '1 match',
  'search.matchCountInGroupPlural': '{{count}} matches',
  /**
   * Phase 1 recommendation: page-name-only hits surface as
   * "1 match (in name)" so users understand why a content-less group
   * appears. Used when a group has exactly one block that is a
   * page-type hit on the title rather than the content.
   */
  // Translators: Group count when the only match is the page's title, not its content.
  'search.matchCountInGroupNameOnly': '1 match (in name)',

  // Translators: Search view: screen-reader labels of a page group's results; {{pageTitle}} = page
  // title.
  'search.groupCollapsedLabel': 'Show matches in {{pageTitle}}',
  'search.groupExpandedLabel': 'Hide matches in {{pageTitle}}',

  // Translators: Search view: tooltip and aria-label of the ? button beside the input; also the
  // title of the Search help dialog.
  'search.helpButtonLabel': 'Search help',

  // Search help dialog (structural strings; the dense
  // token reference inside each section is monospace code, not prose).
  // Translators: Search help dialog: description under the title, then the section headings.
  'search.help.description': 'Search basics: paginated full-text search across blocks and pages.',
  'search.help.section.filterSyntax': 'Filter syntax',
  'search.help.section.toggles': 'Toggles',
  'search.help.section.regexSyntax': 'Regex syntax',
  'search.help.section.booleanOperators': 'Boolean operators',
  'search.help.section.tips': 'Tips',

  // Toggle row (`Aa` / `Ab|` / `.*`) + search history.
  // #154 the abbreviation is now rendered as always-visible text
  // on each toggle, so it is dropped from the accessible name here to
  // avoid a doubled "Case-sensitive A a" screen-reader announcement.
  // Translators: Search view: full names of the three mode toggle buttons beside the input
  // (aria-label and hover tooltip; the buttons show Aa / Ab| / .*), and the toolbar's screen-reader
  // name.
  'search.toggle.caseSensitive': 'Case-sensitive',
  'search.toggle.wholeWord': 'Whole word',
  'search.toggle.regex': 'Regex',
  'search.toggle.toolbarLabel': 'Search modes',

  // Translators: Search view, replace across pages: tooltip and aria-label of the icon button that
  // shows the replace row.
  'search.replace.toggle': 'Replace across pages',

  // Translators: Inserted as {{blocks}} and {{pages}} in search.replace.run, confirmTitle and done.
  'search.replace.blocks_one': '{{count}} block',
  'search.replace.blocks_other': '{{count}} blocks',
  'search.replace.pages_one': '{{count}} page',
  'search.replace.pages_other': '{{count}} pages',

  // Translators: Replace row button, with counts (e.g. "Replace in 3 blocks across 2 pages") or
  // idle. Then the confirmation dialog: {{find}} = searched text, {{replacement}} = new text;
  // "ticked" = matches whose checkbox is checked.
  'search.replace.run': 'Replace in {{blocks}} across {{pages}}',
  'search.replace.runIdle': 'Replace',
  'search.replace.confirmTitle': 'Replace in {{blocks}} across {{pages}}?',
  'search.replace.confirmBody':
    'Every ticked match of \u201C{{find}}\u201D becomes \u201C{{replacement}}\u201D.',
  'search.replace.confirmDelete': 'Every ticked match of \u201C{{find}}\u201D is deleted.',
  'search.replace.confirm': 'Replace',

  // Translators: aria-label of the checkbox on a page group in replace mode; {{pageTitle}} = page
  // title.
  'search.replace.tickPage': 'Replace in {{pageTitle}}',

  // Translators: Status line under the replace field; several notes can be joined with " · ".
  // {{count}} = page titles or tag names that match but are never replaced.
  'search.replace.loading': 'Finding every match\u2026',
  'search.replace.none': 'Nothing to replace',
  'search.replace.noRegex': 'Replace across pages does not take a regex. Turn regex mode off.',
  'search.replace.noText': 'Type the text to replace across pages.',
  'search.replace.tooMany':
    'Too many blocks match to replace them at once. Narrow the search with a filter or a longer text.',
  'search.replace.namesSkipped_one':
    '{{count}} page title or tag name matches and will be left as it is',
  'search.replace.namesSkipped_other':
    '{{count}} page titles or tag names match and will be left as they are',

  // Translators: Toasts after a replace. done and changedSince can be joined with " · ", followed
  // by an Undo button; {{count}} = blocks edited since the search, left unchanged. failed and
  // undoFailed are error toasts.
  'search.replace.done': 'Replaced in {{blocks}} across {{pages}}',
  'search.replace.changedSince_one':
    '{{count}} block changed since the search and was left as it was',
  'search.replace.changedSince_other':
    '{{count}} blocks changed since the search and were left as they were',
  'search.replace.failed': 'Replace failed. Nothing was changed.',
  'search.replace.undoFailed': 'Could not undo the replace',

  // Translators: Search history dropdown under the input: heading, empty state, buttons, and an
  // entry's screen-reader label and remove tooltip ({{query}} = a past search).
  'search.history.title': 'Recent searches',
  'search.history.empty': 'No recent searches',
  'search.history.clear': 'Clear history',
  'search.history.entryLabel': 'Run search: {{query}}',
  'search.history.disable': 'Disable search history',
  'search.history.enable': 'Enable search history',
  'search.history.disabledNotice': 'Search history is off',

  // Translators: Search view: screen-reader name of a valid filter chip; {{value}} = the chip text.
  'search.filterGroupLabel': 'Filter: {{value}}',

  // Translators: Search view, regex mode: only passes {{message}} (the error text) through; keep it
  // as is.
  'search.invalidRegex': '{{message}}',

  // Generic (non-regex) search failure: announced in the live
  // region and shown as a visible inline error state.
  // Translators: Search view errors: live announcement, then an inline error box with a title, body
  // and retry button.
  'search.statusError': 'Search failed',
  'search.errorTitle': 'Search failed',
  'search.errorBody': 'Something went wrong running your search. Try again.',
  'search.errorRetryButton': 'Try again',

  // Result cap notice (the 5000-item ceiling was hit silently).
  // Translators: Search view: notice above the results when the result limit was reached.
  'search.cappedNotice': 'Showing the first results — refine your search to narrow them down.',

  // Cmd+K palette dialog.
  // Translators: Command palette (Ctrl+K): dialog name, screen-reader-only title and description,
  // search input placeholder and aria-label, results list name.
  'palette.dialogLabel': 'Quick search',
  'palette.dialogTitle': 'Search palette',
  'palette.dialogDescription': 'Search for pages and blocks, then run a command.',
  'palette.placeholder': 'Type to search a page or a block…',
  'palette.inputLabel': 'Search pages and blocks',
  'palette.resultsLabel': 'Palette results',

  // Translators: Command palette: group heading for recently opened pages, and a very short chip on
  // a page result whose title matched.
  'palette.recentTitle': 'Recent',
  'palette.titleMatchTag': 'in title',

  // Translators: Command palette: info strip after typing [[ (picking a page inserts a link; Enter
  // is the key); no page matches ({{query}} = typed text); the last row, which opens the Search
  // view (its shortcut follows it).
  'palette.linkModeBadge': 'Linking to page — Enter inserts',
  'palette.noPageMatch': 'No page named “{{query}}”. Type more to refine.',
  'palette.escalateLabel': 'Search in all pages with toggles',

  // Translators: Command palette search results: a page group's screen-reader label
  // ({{pageTitle}}), and a row under it; {{count}} = further matches in that page (keep the +).
  'palette.groupMatchesLabel': 'Matches in {{pageTitle}}',
  'palette.moreInThisPage_one': '+{{count}} more in this page',
  'palette.moreInThisPage_other': '+{{count}} more in this page',

  // Translators: Command palette: shown when nothing matches ({{query}}; "the escalation below" is
  // the row that searches all pages).
  'palette.noResults': 'No matches for “{{query}}”. Try the escalation below.',

  // Footer hint split into per-chord strings so each
  // chord renders as a `<kbd>` chip in the visible UI. Concatenating
  // the chord + label inside one string would put the kbd icon in
  // user-facing translation, which is fragile.
  // Translators: Command palette footer: each hint follows a key chip (↵, Ctrl+Enter, esc). Very
  // short lowercase verbs.
  'palette.footerHintOpen': 'open',
  'palette.footerHintNewTab': 'new tab',
  'palette.footerHintClose': 'close',

  // Translators: Command palette: screen-reader loading text, and the input placeholder in commands
  // mode.
  'palette.searching': 'Searching…',
  'palette.commandsPlaceholder': 'Run a command…',

  // Translators: Command palette mode chip: short name of the current mode, and its aria-label
  // ({{mode}} = one of the mode names).
  'palette.modeSearch': 'Search',
  'palette.modeCommands': 'Commands',
  'palette.modeChipLabel': 'Switch palette mode (current: {{mode}})',

  // Translators: Command palette, commands mode: group headings.
  'palette.cmdGroupNavigate': 'Navigate',
  'palette.cmdGroupAction': 'Actions',

  // #2942 — one entry per `NAV_ITEMS` destination (`nav-items.ts`), plus
  // the Settings › App health tab (#5269, #5360).
  // Translators: Command palette: navigation commands. "App health" is a Settings tab; "Query view"
  // is the advanced query builder; "…" means a further step follows.
  'palette.cmdGoJournal': 'Open Journal view',
  'palette.cmdGoPages': 'Open Pages view',
  'palette.cmdGoTags': 'Open Tags view',
  'palette.cmdGoGraph': 'Open Graph view',
  'palette.cmdShowPageInGraph': 'Show this page in graph',
  'palette.cmdGoTemplates': 'Open Templates view',
  'palette.cmdGoQuery': 'Open Query view',
  'palette.cmdGoStatus': 'Open App health',
  'palette.cmdGoTrash': 'Open Trash',
  'palette.cmdGoHistory': 'Open History',
  'palette.cmdGoSettings': 'Open Settings',
  'palette.cmdSearchEverywhere': 'Search across all pages…',

  // #2942 — global actions that already existed as keyboard shortcuts but
  // had no palette entry.
  // Translators: Command palette: action commands. "Toggle theme" cycles light/dark/system; "page
  // mode" = one editor for the whole page instead of block by block; "New meeting" opens the dialog
  // that creates a meeting page; "Copy page as Markdown" copies it to the clipboard.
  'palette.cmdCreateNewPage': 'Create new page',
  'palette.cmdNewMeeting': 'New meeting',
  'palette.cmdGoToToday': 'Go to today',
  'palette.cmdToggleSidebar': 'Toggle sidebar',
  'palette.cmdToggleTheme': 'Toggle theme',
  'palette.cmdTogglePageMode': 'Switch this page between blocks and page mode',
  'palette.cmdReopenClosedTab': 'Reopen closed tab',
  'palette.cmdNavigateBack': 'Go back',
  'palette.cmdNavigateForward': 'Go forward',
  'palette.cmdExportPageMarkdown': 'Copy page as Markdown',
  'palette.cmdReadPageAloud': 'Read page aloud',
  'palette.cmdStopReading': 'Stop reading aloud',
  // Translators: Error toast when "Copy page as Markdown" runs with no page open.
  'palette.noActivePage': 'No page is open to copy',
  // Translators: Command that opens the keyboard shortcuts list.
  'palette.cmdKeyboardShortcuts': 'Keyboard shortcuts',
  // Translators: Empty state of commands mode.
  'palette.commandsEmpty': 'No commands match — clear the input to see all.',

  // Phase 2 — recent commands strip rendered above Navigate/Actions
  // when the commands-mode filter is empty.
  // Translators: Command palette, commands mode: heading of recently run commands.
  'palette.recentCommandsTitle': 'Recent',

  // Phase 3 — `#` (tags) and `?` (help) prefix modes.
  // Translators: Command palette mode chip names (short): tags mode and help (keyboard shortcuts)
  // mode.
  'palette.modeTags': 'Tags',
  'palette.modeHelp': 'Help',

  // Compact hint showing the prefix vocabulary on the search-mode chip
  // row. With four prefixes the long form ("Type > for commands")
  // doesn't fit; we abbreviate to the glyphs.
  // Translators: Command palette header hint. >, #, ? and [[ are typed prefix characters: keep
  // them; the words must stay very short ("link" = link to a page).
  'palette.modeHint': '> commands · # tags · ? help · [[ link',

  // Hint shown when the user is INSIDE a non-search mode — the chip
  // is the way back.
  // Translators: Command palette header hint outside search mode; "chip" is the mode chip beside
  // it.
  'palette.modeBackHint': 'Click chip to return to search',

  // Tags mode placeholder + status messages.
  // Translators: Command palette, tags mode: group heading, empty states (Enter is the key), and a
  // stand-in for a tag with no name.
  'palette.tagsTitle': 'Tags',
  'palette.tagsWelcomeEmpty': 'Type to filter tags. Enter opens the tag in Search.',
  'palette.tagsNoResults': 'No tags match.',
  'palette.tagsUnnamed': '(unnamed)',

  // Help mode placeholder.
  // Translators: Command palette, help mode (lists keyboard shortcuts): empty state.
  'palette.helpEmpty': 'No shortcuts match the filter.',

  // Phase 4 — bookmark affordance on the recents rows. Removing is worded
  // identically in the sidebar, so both surfaces read `bookmarks.remove`.
  // Translators: Command palette: tooltip and aria-label of the bookmark button on a recent-page
  // row; {{title}} = page title.
  'palette.bookmarkPage': 'Bookmark {{title}}',

  // Phase 5 — per-row action menu labels.
  // Translators: Command palette: action menu of a result row (opened with Tab or the … button).
  // "Open" is the verb; "Open page" is for a block row (opens the page holding it).
  'palette.actionOpen': 'Open',
  'palette.actionOpenPage': 'Open page',
  'palette.actionOpenNewTab': 'Open in new tab',
  'palette.actionBookmark': 'Bookmark',
  'palette.actionRemoveBookmark': 'Remove bookmark',

  // Phase 5 follow-up — expanded action sets.
  // Translators: Command palette action menu: more items; "Reveal" shows the page in the Pages view
  // list.
  'palette.actionReveal': 'Reveal in Pages view',
  'palette.actionCopyPageLink': 'Copy page link',
  'palette.actionCopyBlockLink': 'Copy block link',
  'palette.actionRemoveFromRecents': 'Remove from recents',

  // Translators: Toasts after copying a link from the Command palette; copyFailed also follows the
  // editor's copy-block-link shortcut.
  'palette.copyPageLinkSuccess': 'Page link copied to clipboard',
  'palette.copyLinkSuccess': 'Block link copied to clipboard',
  'palette.copyFailed': 'Could not access clipboard',

  // Search help body
  //
  // Prose for the five SearchHelpDialog body sections (Filter syntax,
  // Toggles, Regex syntax, Boolean operators, Tips). Monospace code
  // identifiers (filter prefixes, regex syntax, examples) stay verbatim
  // inside `<mono>…</mono>` tags so they render as code regardless of
  // locale; only the surrounding prose is translatable. Tags map to the
  // inline elements supplied via `<Trans components={{…}}>`.
  // -- Filter syntax --
  // Translators: Search help dialog, Filter syntax section. Keep <mono>, <strong> and {{…}} markup.
  // Text in <mono> is query syntax and stays as written, except "Add filter" here, which should
  // match the button's translated label.
  'search.help.filter.intro':
    'Filters can be typed directly in the search input or added via the <mono>Add filter</mono> button. Filters AND-combine with the free-text portion.',

  // Translators: Column headings of the filter syntax table: the syntax typed in the query, and
  // what it does.
  'search.help.filter.col.token': 'Token',
  'search.help.filter.col.meaning': 'Meaning',

  // Translators: Meaning column of the filter syntax table; each row's syntax (tag:#name,
  // path:GLOB, state:VALUE, …) is shown beside it. `name`, VALUE, KEY, IS NULL, todo_state,
  // scheduled_date, due:, FTS5, AND/OR are literal: keep them. "Repeats AND" = repeating the filter
  // combines with AND.
  'search.help.filter.cell.tagName':
    'Block carries the tag `name` or a tag nested under it (`name/sub`). Repeats AND.',
  'search.help.filter.cell.bareTag': 'Bare alias for tag:#name.',
  'search.help.filter.cell.underTag':
    'Block carries the tag, or a tag nested under it, attached, written inline, or inherited from its page or a parent block.',
  'search.help.filter.cell.notTag':
    'Block carries neither the tag nor a tag nested under it, attached; inline and inherited tags do not count. Repeats exclude more.',
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

  // Translators: Filter syntax notes. Keep <mono>/<strong> tags; words inside <mono> are syntax. In
  // globs, {{brace}} = "{a,b}".
  'search.help.filter.datePredicates':
    '<strong>Date predicates</strong>: bucket keywords are <mono>today</mono>, <mono>yesterday</mono>, <mono>overdue</mono>, <mono>this-week</mono>, <mono>this-month</mono>, <mono>next-week</mono>, <mono>older</mono>, <mono>none</mono>. Weeks start on Monday.',
  'search.help.filter.propertyFilters':
    '<strong>Property filters</strong>: <mono>prop:KEY=VALUE</mono> matches a stored property value; an empty value (<mono>prop:KEY=</mono>) matches key-presence only. Property keys are <strong>case-sensitive</strong>.',
  'search.help.filter.globs':
    'Glob filters are <strong>case-insensitive</strong> and match against the page title. A bare token like <mono>path:Journal</mono> wraps to <mono>*Journal*</mono> (substring match); add <mono>*</mono>, <mono>?</mono>, or <mono>[...]</mono> for explicit glob syntax. <mono>{{brace}}</mono> brace-expansion is supported (no nesting).',

  // Translators: Filter syntax examples: the query inside <mono> stays as written (Journal, Notes,
  // Archive are page names); translate the description after the dash. {{brace}} =
  // "{Journal,Notes}".
  'search.help.filter.examplesIntro': 'Examples:',
  'search.help.filter.example.todo':
    '<mono>TODO path:Journal/2026-* tag:#urgent</mono> — TODOs on January 2026 journal pages tagged urgent.',
  'search.help.filter.example.meeting':
    '<mono>tag:#meeting not-path:Archive/**</mono> — meetings outside the archive.',
  'search.help.filter.example.brace':
    '<mono>path:{{brace}}/*</mono> — match pages in either Journal or Notes.',

  // -- Toggles --
  // Translators: Search help dialog, Toggles section: intro, table column headings, mode names (as
  // on the toggle buttons) and notes. FTS = the full-text search index; CJK = Chinese, Japanese and
  // Korean; tag: and path: are syntax.
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
  // Translators: Search help dialog, Regex syntax section. Keep <mono>, <strong>, <lnk> tags; each
  // self-closing <m0/>, <m1/>… is replaced by a code token and must appear exactly once. Text in
  // <mono> (regex, Ctrl+F, RegExp, docs/SEARCH.md, patterns) stays as written.
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
  // Translators: Screen-reader label of the <lnk> link in seeAlso.
  'search.help.regex.seeAlsoLinkLabel': 'Rust regex syntax documentation',

  // -- Boolean operators --
  // Translators: Search help dialog, Boolean operators section. AND, OR, NOT are literal operators:
  // keep them in uppercase English. Sample queries in <mono> may translate their words but keep the
  // operators and quotes; "trigram" = the 3-character search index.
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
  // Translators: Search help dialog, Tips section, about the search history dropdown. Keep <kbd>
  // and <strong> tags; ↑ / ↓ are arrow keys.
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
