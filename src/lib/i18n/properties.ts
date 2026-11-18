/**
 * i18n namespace: properties
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const properties: Record<string, string> = {
  // Translators: Query block (a saved search embedded in a page, showing live results):
  // empty state under its header when nothing matches.
  'query.noResults': 'No results',

  // Translators: Query block shown as a table: column headers. "Status" = task state (TODO,
  // DONE…); "Page" = the page each result block is on. Keep short.
  // #4555 — table-mode column headers (`detectColumns` in use-query-table-columns.ts).
  'query.column.content': 'Content',
  'query.column.status': 'Status',
  'query.column.priority': 'Priority',
  'query.column.dueDate': 'Due date',
  'query.column.scheduled': 'Scheduled',
  'query.column.page': 'Page',

  // Translators: Query block error messages, shown in place of its results. Keep `key:NAME`
  // and `target:ULID` verbatim: they are the query's own literal syntax.
  // {{type}} = the unknown query type the user wrote.
  // #4555 — inline-query validation/error text (`useQueryExecution.ts`,
  // `useAdvancedQuery.ts`), rendered inline in QueryResult's error state.
  // `key:NAME` / `target:ULID` are the inline-query mini-language's own
  // literal parameter syntax (not the search-DSL glossary) — kept verbatim.
  'query.propertyRequiresKey': 'Property query requires key:NAME parameter',
  'query.backlinksRequiresTarget': 'Backlinks query requires target:ULID parameter',
  'query.unknownType': 'Unknown query type: {{type}}',
  'query.expressionEmpty': 'Query expression is empty',
  'query.failed': 'Query failed',
  // #6628 — a query block in the search syntax (`query-text.ts`): each token it
  // cannot run, joined into the block's error state.
  // Translators: One problem in a query block written in search syntax; problems are joined
  // with "; ". {{token}} = the filter as typed (e.g. "tag:#work"), {{column}} = its character
  // position, {{message}} = the reason, e.g. query.text.unknownTag (inserted, so no capital);
  // {{name}} = the tag name typed.
  'query.text.problem': '{{token}} (column {{column}}): {{message}}',
  'query.text.unknownTag': "no tag named '{{name}}' in this space",

  // Translators: Query block header: number of results. The "Partial" forms are used while more
  // results remain unloaded, so the count is only what has loaded so far.
  // #1743 — inline query result count. When more pages remain unloaded
  // (`hasMore`), the loaded-so-far count is NOT the true total, so it is
  // labelled as partial ("first N loaded…") rather than presented as the
  // final count (which would mislead vs. the AdvancedQueryView total).
  'query.resultCount_one': '{{count}} result',
  'query.resultCount_other': '{{count}} results',
  'query.resultCountPartial_one': 'first {{count}} loaded',
  'query.resultCountPartial_other': 'first {{count}} loaded',

  // Translators: Query block table: note under the table after a column sort while more rows
  // remain unloaded. {{count}} = rows loaded; "load more" refers to the Load more button below.
  // #3315 item 3 — an inline `table:true` query sorts CLIENT-SIDE over the
  // pages already loaded (`useQuerySorting` has no pagination notion), while
  // `useQueryExecution` pages at 50 with a Load-more button below the table. So
  // a column sort answers "what is the top one?" over the loaded prefix only,
  // not the whole result set. Say so next to the existing partial-count label
  // rather than letting the affordance imply a full-column sort.
  'query.sortPartialNotice_one':
    'Sorted within the {{count}} loaded row only — load more to sort the full result set.',
  'query.sortPartialNotice_other':
    'Sorted within the {{count}} loaded rows only — load more to sort the full result set.',

  // Translators: Query block header badge for a query made in the advanced builder, whose text
  // cannot be shown. {{count}} = number of filter conditions.
  // Label for a structured (`v2:`) inline query, whose payload is opaque
  // base64 — show the condition count rather than the raw expression.
  'query.advancedQueryLabel_one': 'Advanced query · {{count}} condition',
  'query.advancedQueryLabel_other': 'Advanced query · {{count}} conditions',

  // Translators: Advanced Query view (the Query page opened from the Pages header): intro text
  // above the filter builder, empty state, and the total line above the results.
  // {{count}} = matching blocks, or result groups when the results are grouped.
  // #1280 D1 — advanced-query surface.
  'advancedQuery.description':
    'Find blocks by any mix of tags, properties, dates and text. With no conditions, every block in this space is listed.',
  'advancedQuery.noResults': 'No blocks match these filters',
  'advancedQuery.totalCount_one': '{{count}} matching block',
  'advancedQuery.totalCount_other': '{{count}} matching blocks',
  'advancedQuery.groupCount_one': '{{count}} group',
  'advancedQuery.groupCount_other': '{{count}} groups',
  // Polite live-region announcement while a query is (re)fetching.
  // Translators: Screen-reader announcement (and loading label) while the results reload.
  'advancedQuery.searching': 'Searching…',

  // Translators: Advanced Query view, controls under the filter builder. "Query controls" is a
  // screen-reader group name; then the label and placeholder of the free-text search box.
  // #1280 D2 — advanced-query controls (full-text / sort / group-by / aggregate).
  'advancedQuery.controlsLabel': 'Query controls',
  'advancedQuery.fulltext.label': 'Full-text search',
  'advancedQuery.fulltext.placeholder': 'Search block text…',

  // Translators: Advanced Query view, "Sort by" section: "Add sort" adds a row with a field
  // dropdown, a direction dropdown and an icon-only remove button (screen-reader labels).
  // "Relevance" = text-match ranking, offered only while the text search box is filled.
  'advancedQuery.sort.label': 'Sort by',
  'advancedQuery.sort.add': 'Add sort',
  'advancedQuery.sort.remove': 'Remove sort',
  'advancedQuery.sort.sourceLabel': 'Sort field',
  'advancedQuery.sort.dirLabel': 'Sort direction',
  'advancedQuery.sort.asc': 'Ascending',
  'advancedQuery.sort.desc': 'Descending',
  'advancedQuery.sort.relevance': 'Relevance',

  // Translators: Advanced Query view, options of the sort field dropdown. "Created" / "Last
  // edited" = dates; "Position" = the block's place in its page outline.
  'advancedQuery.sort.column.created': 'Created',
  'advancedQuery.sort.column.lastEdited': 'Last edited',
  'advancedQuery.sort.column.position': 'Position',
  'advancedQuery.sort.column.priority': 'Priority',
  'advancedQuery.sort.column.title': 'Page title',

  // Translators: Advanced Query view, "Group by" dropdown and its options. "None" = no grouping;
  // "State" = task state; "Block type" = page, tag or ordinary block. Choosing "Property" shows
  // a text box for the property key (placeholder and screen-reader label).
  'advancedQuery.group.label': 'Group by',
  'advancedQuery.group.none': 'None',
  'advancedQuery.group.tag': 'Tag',
  'advancedQuery.group.page': 'Page',
  'advancedQuery.group.state': 'State',
  'advancedQuery.group.blockType': 'Block type',
  'advancedQuery.group.priority': 'Priority',
  'advancedQuery.group.property': 'Property',
  'advancedQuery.group.propertyKeyLabel': 'Property key to group by',
  'advancedQuery.group.propertyKeyPlaceholder': 'Property key',

  // Translators: Advanced Query view, "Group by" › "Date": groups results by a date. Two dropdowns
  // follow (screen-reader labels): which date (due, scheduled, created, last edited) and the
  // size of each group (day, week, month).
  'advancedQuery.group.dateBucket': 'Date',
  'advancedQuery.group.dateSourceLabel': 'Date to group by',
  'advancedQuery.group.dateSource.due': 'Due',
  'advancedQuery.group.dateSource.scheduled': 'Scheduled',
  'advancedQuery.group.dateSource.created': 'Created',
  'advancedQuery.group.dateSource.lastEdited': 'Last edited',
  'advancedQuery.group.dateUnitLabel': 'Bucket size',
  'advancedQuery.group.dateUnit.day': 'Day',
  'advancedQuery.group.dateUnit.week': 'Week',
  'advancedQuery.group.dateUnit.month': 'Month',

  // Translators: Advanced Query view, "View" toggle: results as a list or as a board (Kanban
  // columns of cards). The hint shows under it while Board is unavailable.
  'advancedQuery.view.label': 'View',
  'advancedQuery.view.list': 'List',
  'advancedQuery.view.board': 'Board',
  'advancedQuery.view.boardHint': 'Group by State or by a select property to see a board.',

  // Translators: Advanced Query board view (Kanban columns of cards). "No value" / "Other values"
  // are column titles for blocks with no value / a value outside the options. {{column}} = a
  // column title; moved / moveFailed are toasts after moving a card. dragInstructions is read
  // by screen readers; its "Move to…" must match the card button text (board.moveTo).
  'advancedQuery.board.noValue': 'No value',
  'advancedQuery.board.other': 'Other values',
  'advancedQuery.board.emptyColumn': 'No blocks in “{{column}}”',
  'advancedQuery.board.moveTo': 'Move to…',
  'advancedQuery.board.moved': 'Moved to {{column}}',
  'advancedQuery.board.moveFailed': 'Could not move the card',
  'advancedQuery.board.dragInstructions':
    'Drag a card onto another column to move it there, or use the card’s Move to… button.',

  // Translators: Advanced Query view, "Summaries" section (totals computed over the results):
  // "Add summary" adds a row with a type dropdown, a target dropdown and an icon-only remove
  // button; "Summary type" / "Summarize" are the screen-reader names of the two dropdowns.
  'advancedQuery.aggregate.label': 'Summaries',
  'advancedQuery.aggregate.add': 'Add summary',
  'advancedQuery.aggregate.remove': 'Remove summary',
  'advancedQuery.aggregate.opLabel': 'Summary type',
  'advancedQuery.aggregate.targetLabel': 'Summarize',

  // Translators: Summary types (math aggregates): options of the type dropdown, and the start of
  // each result chip, as in "Sum: 42". Count = number of values; Average = mean.
  'advancedQuery.aggregate.op.count': 'Count',
  'advancedQuery.aggregate.op.sum': 'Sum',
  'advancedQuery.aggregate.op.avg': 'Average',
  'advancedQuery.aggregate.op.min': 'Minimum',
  'advancedQuery.aggregate.op.max': 'Maximum',

  // Translators: What a summary is computed over: options of the target dropdown. "Rows" = the
  // result rows themselves; "Position" = the block's place in its outline. "Property" shows a
  // text box for the property key (placeholder and screen-reader label).
  'advancedQuery.aggregate.target.none': 'Rows',
  'advancedQuery.aggregate.target.priority': 'Priority',
  'advancedQuery.aggregate.target.position': 'Position',
  // #4553 Phase 1 — `AggregateTarget::Property`: sum/avg/min/max over a
  // named property's numeric value, not just the two fixed columns above.
  'advancedQuery.aggregate.target.property': 'Property',
  'advancedQuery.aggregate.propertyKeyLabel': 'Property to summarize',
  'advancedQuery.aggregate.propertyKeyPlaceholder': 'Property key',

  // Translators: Advanced Query summary chip suffix, after a chip like "Average: 2.5". Keep the
  // math notation "n="; {{n}} = how many numeric values were counted.
  // #4553 Phase 1 — the contributing NUMERIC count beside a sum/avg/min/max
  // chip, when the request also asked for a matching Count over the same
  // target (`avg` divides by this, not the total row count).
  // Interpolated as `{{n}}`, deliberately NOT `{{count}}`. i18next keys its
  // plural machinery on the option name `count`, and this is a bare number in
  // mathematical notation with no surrounding noun to inflect — there is no
  // singular wording for it to select. Naming it `count` would opt into
  // pluralisation for a string that can never pluralise, and then need an
  // entry in `PRE_EXISTING_COUNT_EXEMPT` to say so (#3860/#3882).
  'advancedQuery.aggregate.contributingCount': '(n={{n}})',

  // Translators: Advanced Query results. summaryLabel / group.summaryLabel are screen-reader names
  // of the summary chips and the grouped list; "(none)" heads the group of blocks with no value;
  // countLabel sits beside each group heading, {{count}} = blocks in that group.
  'advancedQuery.aggregate.summaryLabel': 'Summary results',
  'advancedQuery.group.summaryLabel': 'Group results',
  'advancedQuery.group.noneKey': '(none)',
  'advancedQuery.group.countLabel_one': '{{count}} block',
  'advancedQuery.group.countLabel_other': '{{count}} blocks',

  // Translators: Advanced Query filter builder (nested AND / OR groups of conditions), also in the
  // Build Query dialog's Advanced tab. "Filter" / "Filter group" are screen-reader names of the
  // top and nested groups; "Match" names the All / Any toggle (how a group combines its
  // conditions), whose tooltips explain each choice.
  // #1280 D3 — nested And/Or/Not boolean filter builder.
  'advancedQuery.builder.rootLabel': 'Filter',
  'advancedQuery.builder.groupLabel': 'Filter group',
  'advancedQuery.builder.opLabel': 'Match',
  'advancedQuery.builder.op.and': 'All',
  'advancedQuery.builder.op.or': 'Any',
  'advancedQuery.builder.op.andTitle': 'Match ALL of the conditions in this group (AND)',
  'advancedQuery.builder.op.orTitle': 'Match ANY of the conditions in this group (OR)',

  // Translators: Builder NOT toggle on each group and condition: "NOT" is the short button text
  // (shown in capitals); the titles are its tooltips. {{kind}} = kindGroup or kindLeaf, inserted
  // mid-sentence (lowercase): "group" = a nested group, "condition" = one filter.
  'advancedQuery.builder.negate': 'NOT',
  'advancedQuery.builder.negateTitle': 'Negate this {{kind}} (wrap in NOT)',
  'advancedQuery.builder.negateOnTitle': 'Negated — click to un-negate this {{kind}}',
  'advancedQuery.builder.kindGroup': 'group',
  'advancedQuery.builder.kindLeaf': 'condition',

  // Translators: Builder buttons. "Remove {{kind}}" is the remove button of a nested group and
  // the screen-reader label of a condition's remove icon. The empty texts show in a group with no
  // conditions; "Clear all" removes every condition.
  'advancedQuery.builder.addFilter': 'Add filter',
  'advancedQuery.builder.addGroup': 'Add group',
  'advancedQuery.builder.removeNode': 'Remove {{kind}}',
  'advancedQuery.builder.emptyGroupAnd': 'No conditions yet: every block matches',
  'advancedQuery.builder.emptyGroupOr': 'No conditions yet: no block matches',
  'advancedQuery.builder.clearAll': 'Clear all',

  // Translators: Advanced Query view, "Saved views" (named queries saved in this space): heading,
  // "Save view" button (tooltip saveTitle) opening a name dialog (namePrompt), toasts, and the
  // empty list. {{name}} = the view name; nameIsDate: a name may not look like a date.
  // #1460 D3 — saved views (persist / list / load / rename / delete).
  'advancedQuery.savedViews.label': 'Saved views',
  'advancedQuery.savedViews.save': 'Save view',
  'advancedQuery.savedViews.saveTitle': 'Save the current query as a named view',
  'advancedQuery.savedViews.namePrompt': 'Name this view:',
  'advancedQuery.savedViews.saved': 'Saved view "{{name}}"',
  'advancedQuery.savedViews.saveError': 'Could not save the view',
  'advancedQuery.savedViews.nameTaken':
    'A page or view named "{{name}}" already exists in this space',
  'advancedQuery.savedViews.nameIsDate': 'A view cannot be named like a date: "{{name}}"',
  'advancedQuery.savedViews.renameError': 'Could not rename the view',
  'advancedQuery.savedViews.deleteError': 'Could not delete the view',
  'advancedQuery.savedViews.empty': 'No saved views yet',

  // Translators: Each saved view row: short Load / Rename / Delete buttons, with screen-reader
  // labels naming the view ({{name}}); then the rename and delete dialogs and their toasts.
  'advancedQuery.savedViews.load': 'Load',
  'advancedQuery.savedViews.loadTitle': 'Load "{{name}}"',
  'advancedQuery.savedViews.loaded': 'Loaded view "{{name}}"',
  'advancedQuery.savedViews.loadError': 'Could not load this view',
  'advancedQuery.savedViews.rename': 'Rename',
  'advancedQuery.savedViews.renameTitle': 'Rename "{{name}}"',
  'advancedQuery.savedViews.renamePrompt': 'New name for this view:',
  'advancedQuery.savedViews.renamed': 'Renamed view to "{{name}}"',
  'advancedQuery.savedViews.delete': 'Delete',
  'advancedQuery.savedViews.deleteTitle': 'Delete "{{name}}"',
  'advancedQuery.savedViews.deleteConfirm':
    'Delete saved view "{{name}}"? You can restore it from the Trash.',
  'advancedQuery.savedViews.deleted': 'Deleted view "{{name}}"',

  // Translators: Build Query dialog, Operator dropdown: description shown beside each math symbol
  // (=, ≠, <, >, ≤, ≥). Lowercase.
  'query.operator.eqDesc': 'equals',
  'query.operator.neqDesc': 'not equal',
  'query.operator.ltDesc': 'less than',
  'query.operator.gtDesc': 'greater than',
  'query.operator.lteDesc': 'less than or equal',
  'query.operator.gteDesc': 'greater than or equal',

  // Translators: Build Query dialog (creates or edits a query block in a page): title, subtitle,
  // and the query-type toggle (typeLabel = its screen-reader name). "Backlinks" = blocks that
  // link to a given page.
  'queryBuilder.title': 'Build query',
  'queryBuilder.description': 'Create an inline query to embed in your page.',
  'queryBuilder.typeLabel': 'Query type',
  'queryBuilder.type.tag': 'Tag',
  'queryBuilder.type.property': 'Property',
  'queryBuilder.type.backlinks': 'Backlinks',

  // Translators: Build Query dialog form fields (label, placeholder, help) for each query type.
  // The tag examples may be translated ("/" nests a tag); keep the property keys "priority" and
  // "due_date" and the ID format name "ULID". {{key}} = the property key typed.
  'queryBuilder.tagPrefix': 'Tag prefix',
  'queryBuilder.tagPrefixPlaceholder': 'e.g. work, project/active',
  'queryBuilder.propertyKey': 'Property key',
  'queryBuilder.propertyKeyPlaceholder': 'e.g. priority, due_date',
  'queryBuilder.propertyKeyUnknown':
    '"{{key}}" is not yet defined on this device. The query will still run; matches appear once the property exists.',
  'queryBuilder.propertyOperator': 'Operator',
  'queryBuilder.propertyValue': 'Value',
  'queryBuilder.propertyValuePlaceholder': 'e.g. 1, 2025-04-01',
  'queryBuilder.backlinkTarget': 'Target page ID',
  'queryBuilder.backlinkTargetPlaceholder': 'Enter page ULID',
  'queryBuilder.backlinkTargetHelper': 'Enter the ID of the page to show backlinks for',

  // Translators: Build Query dialog: checkbox to show the results as a table, and the heading of
  // the preview of the generated query.
  'queryBuilder.showAsTable': 'Show results as table',
  'queryBuilder.preview': 'Preview',

  // Translators: Build Query dialog preview: the query read out in plain words. {{expr}} = tag
  // names typed, {{key}} / {{value}} = property key / value, {{target}} = a page ID, {{op}} = one
  // of the readable.op.* phrases below (inserted mid-sentence, lowercase).
  'queryBuilder.readable.tag': 'Pages tagged with {{expr}}',
  'queryBuilder.readable.propertyKeyOnly': 'Pages with property "{{key}}" set to anything',
  'queryBuilder.readable.propertyKeyValue': 'Pages where property "{{key}}" {{op}} "{{value}}"',
  'queryBuilder.readable.backlinks': 'Blocks that link to {{target}}',
  'queryBuilder.readable.table': 'Display as a table.',
  'queryBuilder.readable.op.eq': 'is',
  'queryBuilder.readable.op.neq': 'is not',
  'queryBuilder.readable.op.lt': 'is less than',
  'queryBuilder.readable.op.lte': 'is at most',
  'queryBuilder.readable.op.gt': 'is greater than',
  'queryBuilder.readable.op.gte': 'is at least',

  // Translators: Build Query dialog footer buttons: Insert (new query) or Update (editing one).
  'queryBuilder.insertButton': 'Insert query',
  'queryBuilder.updateButton': 'Update query',
  'queryBuilder.cancelButton': 'Cancel',

  // Translators: Query block header: screen-reader label of the pencil button that opens the Build
  // Query dialog; propertiesFailed = error toast when the table's columns fail to load.
  'queryBuilder.editButton': 'Edit query',
  'queryBuilder.propertiesFailed': 'Failed to load query result properties',

  // Translators: Build Query dialog mode tabs: "Simple" form or "Advanced" nested-group builder
  // (mode.label = screen-reader name of the tabs); filterCount counts the conditions added.
  // notText / textOnly explain a query that is stored coded or can only be edited as text.
  'queryBuilder.mode.label': 'Builder mode',
  'queryBuilder.mode.simple': 'Simple',
  'queryBuilder.mode.advanced': 'Advanced',
  'queryBuilder.advanced.hint': 'Combine conditions with AND / OR / NOT and nested groups.',
  'queryBuilder.advanced.empty': 'Add at least one filter to build an advanced query.',
  'queryBuilder.advanced.filterCount_one': '{{count}} filter',
  'queryBuilder.advanced.filterCount_other': '{{count}} filters',
  'queryBuilder.advanced.notText':
    "This filter can't be written as text, so the block stores it in a coded form.",
  'queryBuilder.textOnly':
    'This query uses a filter the builder has no control for. It can only be edited as text, in the block itself.',

  // Translators: BlockPropertyDrawer (side panel listing a block's properties): title, subtitle,
  // loading text, empty state, and the error (toast, or the error state in Settings › Properties)
  // when properties fail to load.
  'property.drawerTitle': 'Block properties',
  'property.drawerDescription':
    'View, edit and add properties for this block (status, priority, dates, custom fields).',
  'property.loading': 'Loading...',
  'property.noProperties': 'No properties set',
  'property.loadFailed': 'Failed to load properties',

  // Translators: Block property editing: error toasts, the screen-reader label of a property's
  // remove button, the add button, and the delete confirmation dialog (title + body). In
  // invalidBoolean, "true" and "false" are the literal values to type: keep them.
  'property.saveFailed': 'Failed to save property',
  'property.deleteFailed': 'Failed to delete property',
  'property.delete': 'Delete property',
  'property.addProperty': 'Add property',
  'property.invalidNumber': 'Invalid number value',
  'property.invalidBoolean': 'Invalid boolean value — use true or false',
  'property.deleteConfirm': 'Delete this property?',
  'property.deleteConfirmDesc': 'This will remove the property from the block.',
  'property.createDefFailed': 'Failed to create property definition',

  // Translators: Display names of built-in block properties (field labels). "Due" / "Scheduled" =
  // task dates; "Effort" = estimated work time; "Todo State" = task state (TODO, DONE…). "Repeat…"
  // = recurring-task settings: Seq = occurrences so far, Origin = the original date.
  'property.dueDate': 'Due',
  'property.scheduledDate': 'Scheduled',
  'property.createdAt': 'Created at',
  'property.completedAt': 'Completed at',
  'property.effort': 'Effort',
  'property.assignee': 'Assignee',
  'property.location': 'Location',
  'property.repeat': 'Repeat',
  'property.repeatUntil': 'Repeat until',
  'property.repeatCount': 'Repeat count',
  'property.repeatSeq': 'Repeat seq',
  'property.repeatOrigin': 'Repeat origin',
  'property.todoState': 'Todo state',
  'property.priority': 'Priority',

  // Translators: BlockPropertyDrawer fields and inline property chips: screen-reader labels of the
  // clear, value and checkbox controls ({{key}} = property name), the Yes / No a true/false
  // property shows, and openRefTarget on a chip linking to a page ({{title}} = page title).
  'property.clearDueDate': 'Clear due date',
  'property.clearScheduledDate': 'Clear scheduled date',
  'property.valueLabel': '{{key}} value',
  'property.booleanToggle': 'Toggle boolean property {{key}}',
  'property.booleanTrue': 'Yes',
  'property.booleanFalse': 'No',
  'property.openRefTarget': 'Open {{title}}',

  // Translators: A property holding several values (a list): screen-reader label and placeholder
  // of the add-item box ({{key}} = property name), and the remove label of each item chip
  // ({{item}} = the item's text).
  // #6741 — the items of a property that holds several values.
  'property.addListItem': 'Add an item to {{key}}',
  'property.addListItemPlaceholder': 'Add an item',
  'property.removeListItem': 'Remove {{item}}',

  // Translators: A property value that doesn't fit its property's type. unfitReview = tooltip of
  // the warning icon (opens Settings › Properties); unfitChipLabel = screen-reader chip label.
  // {{key}} = property name, {{value}} = the stored value.
  'property.unfitReview': "{{value}} doesn't fit {{key}}: review its values",
  'property.unfitChipLabel': "{{key}}: {{value}}, doesn't fit",

  // Translators: Placeholder of a property dropdown (pick a property).
  'property.selectProperty': 'Select property...',

  // Translators: Settings › Properties: error toasts when loading, creating, editing the options
  // of, or deleting a property definition (a property's declared type and options).
  'property.errorLoad': 'Failed to load property definitions',
  'property.errorCreate': 'Failed to create property definition',
  'property.errorUpdate': 'Failed to update options',
  'property.errorDelete': 'Failed to delete property definition',

  // Translators: Settings › Properties (the space's property definitions): search box, empty
  // state, and the create form: key box, type dropdown (screen-reader label "Type"), Create button.
  'propertiesView.search': 'Search properties...',
  'propertiesView.empty': 'No property definitions yet',
  'propertiesView.createKey': 'Property key',
  'propertiesView.createType': 'Type',
  'propertiesView.create': 'Create',

  // Translators: Settings › Properties delete confirmation (title + body) and toasts. In
  // deleteRefusedInUse, {{reason}} = the app's full sentence saying the property is still in use.
  'propertiesView.deleteConfirm': 'Delete this property definition?',
  'propertiesView.deleteDesc':
    "A property still in use in this space can't be deleted. Remove it from every block that uses it first.",
  'propertiesView.deleted': 'Property definition deleted',
  'propertiesView.deleteRefusedInUse':
    '{{reason}} Blocks in the Trash count too, until you permanently delete them.',

  // Translators: Settings › Properties, badge beside each property: how many blocks use it.
  'propertiesView.usageCount_one': '{{count}} use',
  'propertiesView.usageCount_other': '{{count}} uses',

  // Translators: Settings › Properties toasts after a change (each offers Undo), and the error
  // toast when that Undo fails.
  'propertiesView.created': 'Property definition created',
  'propertiesView.optionsSaved': 'Options saved',
  'propertiesView.undoFailed': 'Could not undo the change to the property definition',

  // Translators: Settings › Properties: "Edit options" button of a select property (one with a
  // fixed list of choices); duplicateKey = error under the key box when that key already exists.
  'propertiesView.editOptions': 'Edit options',
  'propertiesView.duplicateKey': 'A property with this key already exists',

  // Translators: Settings › Tasks & reminders: setting row (label + description) taking a number of
  // days. "Upcoming" = the Agenda section of that name.
  'propertiesView.deadlineWarning': 'Deadline warning',
  'propertiesView.deadlineWarningDesc':
    "Show tasks due within this many days in the Agenda's Upcoming list. 0 turns it off.",

  // Translators: Settings › Properties: lock badge on a built-in (fixed) property, and the label
  // before the space dropdown that picks whose definitions are listed ("Definitions in [space]").
  'propertiesView.builtIn': 'Built-in',
  'propertiesView.definitionsIn': 'Definitions in',

  // Translators: Settings › Properties, copy icon button (tooltip + screen-reader label) opening a
  // menu of the other spaces, and its toasts. {{key}} = property key, {{space}} = space name,
  // {{type}} = the type already defined there, an English code like "number".
  'propertiesView.copyToSpaceTooltip': 'Copy to space…',
  'propertiesView.copyToSpaceLabel': 'Copy {{key}} to another space',
  'propertiesView.copyToSpaceMenuLabel': 'Spaces to copy {{key}} to',
  'propertiesView.copiedToSpace': 'Copied {{key}} to {{space}}',
  'propertiesView.copyKeptExisting':
    '{{space}} already defines {{key}} as {{type}}; its definition was kept',
  'propertiesView.copyFailed': 'Failed to copy the property definition',

  // Translators: Settings › Properties, rename icon button, its dialog (title, body, key box) and
  // toasts. {{key}} / {{from}} / {{to}} = property keys; reservedKey = error for a key the app
  // keeps for itself.
  'propertiesView.renameTooltip': 'Rename property',
  'propertiesView.renameLabel': 'Rename property {{key}}',
  'propertiesView.renameTitle': 'Rename {{key}}',
  'propertiesView.renameDescription':
    'Every block in this space that has {{key}}, the Trash included, gets the new key.',
  'propertiesView.renameInputLabel': 'New property key',
  'propertiesView.reservedKey': '{{key}} is used by the app',
  'propertiesView.renamed': 'Renamed {{from}} to {{to}}',
  'propertiesView.renameFailed': 'Failed to rename the property',

  // Translators: Toasts after renaming one option of a select property. {{from}} / {{to}} = option
  // names, {{key}} = property key.
  'propertiesView.optionRenamed': 'Renamed {{from}} to {{to}} in {{key}}',
  'propertiesView.renameOptionFailed': 'Failed to rename the option',

  // Translators: Settings › Properties, "Merge into…" icon button and dialog: pick another
  // property; counts preview what moves and what is dropped. {{key}} / {{from}} = the property
  // merged away, {{into}} = the target property; mergeCountsChanged = alert when the counts
  // changed meanwhile.
  'propertiesView.mergeTooltip': 'Merge into…',
  'propertiesView.mergeLabel': 'Merge {{key}} into…',
  'propertiesView.mergeTitle': 'Merge {{key}} into another property',
  'propertiesView.mergeDescription':
    '{{key}} is removed from this space; its values move to the property you pick.',
  'propertiesView.mergeTargetLabel': 'Property to merge into',
  'propertiesView.mergeTargetPlaceholder': 'Pick a property',
  'propertiesView.mergeMoves_one': '{{count}} value moves to {{into}}.',
  'propertiesView.mergeMoves_other': '{{count}} values move to {{into}}.',
  'propertiesView.mergeDrops_one':
    '{{count}} block already has {{into}}; its {{from}} value is removed (Undo brings it back).',
  'propertiesView.mergeDrops_other':
    '{{count}} blocks already have {{into}}; their {{from}} value is removed (Undo brings it back).',
  'propertiesView.mergeTrashNote': 'Blocks in the Trash count too.',
  'propertiesView.mergeCountsChanged': 'The counts changed; check and confirm again.',
  'propertiesView.mergeConfirm': 'Merge',
  'propertiesView.merged': 'Merged {{from}} into {{into}}',
  'propertiesView.mergeFailed': 'Failed to merge the properties',
  'propertiesView.mergePreviewFailed': 'Could not count the values to merge',

  // Translators: Settings › Properties, "Change type…" icon button and dialog: title, body, and the
  // screen-reader label of the new-type dropdown. {{key}} = property key.
  'propertiesView.typeChangeTooltip': 'Change type…',
  'propertiesView.typeChangeLabel': 'Change the type of {{key}}',
  'propertiesView.typeChangeTitle': 'Change the type of {{key}}',
  'propertiesView.typeChangeDescription':
    "Each value of {{key}} in this space is converted to the new type. A value that doesn't fit is kept as text and no longer counts as that type: the Agenda, for example, skips a value that isn't a date.",
  'propertiesView.typeChangeTypeLabel': 'New type',

  // Translators: Change type dialog, when values become lists or lists become one value: a question
  // label and three short toggle buttons choosing the separator.
  'propertiesView.typeChangeSplitLabel': 'Split each value into items',
  'propertiesView.typeChangeSplitComma': 'Split at commas',
  'propertiesView.typeChangeSplitSemicolon': 'Split at semicolons',
  'propertiesView.typeChangeSplitNone': "Don't split",
  'propertiesView.typeChangeJoinLabel': 'Join the items of each list into one value',
  'propertiesView.typeChangeJoinComma': 'Join with commas',
  'propertiesView.typeChangeJoinSemicolon': 'Join with semicolons',
  'propertiesView.typeChangeJoinNone': "Don't join",

  // Translators: Change type dialog preview and result. {{count}} = values; {{type}} = the new
  // type, an English code like "date" (in typeChanged it may read "select · several values").
  // The two tabs list values that don't fit / that convert. typeChangeCountsChanged is also the
  // alert of the other value dialogs when the counts changed before confirming.
  'propertiesView.typeChangeConverts_one': '{{count}} value is converted.',
  'propertiesView.typeChangeConverts_other': '{{count}} values are converted.',
  'propertiesView.typeChangeUnfit_one':
    "{{count}} value isn't a {{type}}: it is kept as text and no longer counts as one.",
  'propertiesView.typeChangeUnfit_other':
    "{{count}} values aren't a {{type}}: they are kept as text and no longer count as one.",
  'propertiesView.typeChangeTrashNote': 'Blocks in the Trash count too.',
  'propertiesView.typeChangeValuesLabel': 'Values the change touches',
  'propertiesView.typeChangeUnfitTab_one': "Don't fit ({{count}})",
  'propertiesView.typeChangeUnfitTab_other': "Don't fit ({{count}})",
  'propertiesView.typeChangeConvertedTab_one': 'Converted ({{count}})',
  'propertiesView.typeChangeConvertedTab_other': 'Converted ({{count}})',
  'propertiesView.typeChangeCountsChanged': 'The values changed; check and confirm again.',
  'propertiesView.typeChangeConfirm': 'Change type',
  'propertiesView.typeChanged': 'Changed {{key}} to {{type}}',
  'propertiesView.typeChangeFailed': 'Failed to change the property type',
  'propertiesView.typeChangePreviewFailed': 'Could not count the values to change',

  // Translators: Settings › Properties, warning badge beside a property whose values don't all fit
  // its type ({{count}} = such values; keep the badge short), and its screen-reader label.
  'propertiesView.unfitBadge_one': "{{count}} doesn't fit",
  'propertiesView.unfitBadge_other': "{{count}} don't fit",
  'propertiesView.unfitLabel_one': "{{count}} doesn't fit: review the value of {{key}}",
  'propertiesView.unfitLabel_other': "{{count}} don't fit: review the values of {{key}}",

  // Translators: "Values that don't fit" dialog: title, body and counts. {{key}} = property key,
  // {{type}} = its type, an English code like "date".
  'propertiesView.unfitTitle': "Values of {{key}} that don't fit",
  'propertiesView.unfitDescription':
    "These values don't fit {{key}}'s type or options, so they don't count as a {{type}}. Remove takes them off their blocks, the Trash included; Undo puts them back.",
  'propertiesView.unfitCount_one': "{{count}} value doesn't fit.",
  'propertiesView.unfitCount_other': "{{count}} values don't fit.",
  'propertiesView.unfitInTrash_one': '{{count}} more in the Trash.',
  'propertiesView.unfitInTrash_other': '{{count}} more in the Trash.',

  // Translators: That dialog's list: the reason shown beside each value. {{form}} = how the value
  // is stored, an English code ("text", "number", "date", "ref", "boolean", "list");
  // {{type}} likewise.
  // unfitNone = empty state when no such values remain.
  'propertiesView.unfitNotAnOption': 'Not one of the options',
  'propertiesView.unfitForm': '{{form}}, not {{type}}',
  'propertiesView.unfitNotAList': 'One value, not a list',
  'propertiesView.unfitAList': 'A list, not one value',
  'propertiesView.unfitItem': "An item isn't a {{type}}",
  'propertiesView.unfitItemNotAnOption': 'An item is not one of the options',
  'propertiesView.unfitNone': "No values left that don't fit",

  // Translators: That dialog's buttons (Remove, Add to options) and toasts. {{count}} = values,
  // {{key}} = property key. "Options" = the fixed choices of a select property.
  'propertiesView.unfitRemove': 'Remove',
  'propertiesView.unfitAddToOptions': 'Add to options',
  'propertiesView.unfitRemoved_one': "Removed {{count}} value of {{key}} that didn't fit",
  'propertiesView.unfitRemoved_other': "Removed {{count}} values of {{key}} that didn't fit",
  'propertiesView.unfitAddedToOptions': 'Added the values to the options of {{key}}',
  'propertiesView.unfitNothingToAdd': 'Nothing to add: only a text can become an option',
  'propertiesView.unfitRemoveFailed': "Failed to remove the values that don't fit",
  'propertiesView.unfitAddFailed': 'Failed to add the values to the options',

  // Translators: "Convert…" step of that dialog: a replacement for each value. {{type}} = an
  // English type code; per value, block counts (convertBlocks, convertInTrash, joined by ", ")
  // and a replacement field whose convertLeave choice keeps the value; then the button and toasts.
  'propertiesView.convertOpen': 'Convert…',
  'propertiesView.convertIntro':
    'Give each value a replacement that fits a {{type}}. A value left empty stays as it is.',
  'propertiesView.convertIntroList':
    'Give each value a replacement: its items, each a {{type}}, separated by commas. A value left empty stays as it is.',
  'propertiesView.convertBlocks_one': '{{count}} block',
  'propertiesView.convertBlocks_other': '{{count}} blocks',
  'propertiesView.convertInTrash_one': '{{count}} in the Trash',
  'propertiesView.convertInTrash_other': '{{count}} in the Trash',
  'propertiesView.convertReplacementLabel': 'Replacement for {{value}}',
  'propertiesView.convertLeave': 'Leave as it is',
  'propertiesView.convertSummary_one': '{{count}} block will change.',
  'propertiesView.convertSummary_other': '{{count}} blocks will change.',
  'propertiesView.convertConfirm_one': 'Convert {{count}}',
  'propertiesView.convertConfirm_other': 'Convert {{count}}',
  'propertiesView.convertDone_one': 'Converted {{count}} value of {{key}}',
  'propertiesView.convertDone_other': 'Converted {{count}} values of {{key}}',
  'propertiesView.convertFailed': "Failed to convert the values that don't fit",

  // Translators: "Move to…" step of that dialog: move the values to another property on the same
  // blocks. {{key}} = this property, {{into}} = the target property, {{count}} = values.
  'propertiesView.moveOpen': 'Move to…',
  'propertiesView.moveIntro':
    "Move them to another property, on the same blocks. A value moves where that property's type takes it; it stays on {{key}} when it doesn't, or when its block already has that property.",
  'propertiesView.moveTargetLabel': 'Property to move them to',
  'propertiesView.moveTargetPlaceholder': 'Pick a property',
  'propertiesView.moveMoves_one': '{{count}} value moves to {{into}}.',
  'propertiesView.moveMoves_other': '{{count}} values move to {{into}}.',
  'propertiesView.moveOccupied_one': '{{count}} stays: its block already has {{into}}.',
  'propertiesView.moveOccupied_other': '{{count}} stay: their blocks already have {{into}}.',
  'propertiesView.moveUnfitThere_one': "{{count}} stays: it doesn't fit {{into}} either.",
  'propertiesView.moveUnfitThere_other': "{{count}} stay: they don't fit {{into}} either.",
  'propertiesView.moveConfirm_one': 'Move {{count}}',
  'propertiesView.moveConfirm_other': 'Move {{count}}',
  'propertiesView.moveDone_one': 'Moved {{count}} value from {{key}} to {{into}}',
  'propertiesView.moveDone_other': 'Moved {{count}} values from {{key}} to {{into}}',
  'propertiesView.moveFailed': "Failed to move the values that don't fit",
  'propertiesView.movePreviewFailed': 'Could not count the values to move',

  // Translators: Settings › Properties: screen-reader label of the search box's clear button,
  // tooltips of the delete and edit-options buttons, and the no-match empty state.
  'propertiesView.clearSearch': 'Clear search',
  'propertiesView.deleteTooltip': 'Delete property',
  'propertiesView.editOptionsTooltip': 'Edit options',
  'propertiesView.noFilterResults': 'No properties match your search',

  // Translators: Settings › Properties, help icon beside the built-in task-state property, and its
  // tooltip. Keep TODO, DOING, DONE and CANCELLED as they are: they are the task states shown.
  'propertiesView.taskCycleHelpLabel': 'Task cycle help',
  'propertiesView.taskCycleHelpContent':
    'Task states cycle in a fixed order: TODO → DOING → DONE → CANCELLED → none. The order puts the common terminal (DONE) immediately after work begins (DOING); CANCELLED is the abandon-without-completing escape hatch at the end.',

  // Translators: Settings › Properties: screen-reader label of a property's delete button.
  'properties.deleteDefinition': 'Delete property {{key}}',

  // Translators: Page picker of a property that links to a page: empty state (title + hint) and a
  // button creating a page with the searched name ({{name}}).
  'properties.refPickerEmptyTitle': 'No pages found',
  'properties.refPickerEmptyDescription': 'Try a different search term.',
  'properties.createNewPageAction': 'Create new page "{{name}}"',

  // Translators: BlockPropertyDrawer while loading: screen-reader label of the loading placeholder
  // and the tooltip of the disabled add-property button.
  'properties.loadingPropertiesTitle': 'Loading properties\u2026',
  'properties.loadingPropertiesDisabled': 'Properties loading\u2026',

  // Translators: Options editor of a select property (popover): badge counting its options.
  'properties.optionsCount_one': '{{count}} option',
  'properties.optionsCount_other': '{{count}} options',

  // Translators: Add-property popover: hint after the button that creates a new property, naming
  // its default type. Keep the parentheses.
  'properties.createNewTypeHint': '(text)',

  // Translators: Options editor rows: screen-reader labels and tooltips of each option's move,
  // rename, save and cancel buttons ({{option}} = option name); optionTaken = error for a name
  // already in the list.
  'properties.moveOptionUp': 'Move option {{option}} up',
  'properties.moveOptionDown': 'Move option {{option}} down',
  'properties.renameOption': 'Rename option {{option}}',
  'properties.renameOptionInput': 'New name for {{option}}',
  'properties.saveOptionName': 'Save option name',
  'properties.cancelOptionRename': 'Cancel rename',
  'properties.optionTaken': 'Already an option',

  // Translators: Page picker of a property that links to a page: screen-reader label of the spinner
  // while the picked page is saved.
  'properties.savingRefValue': 'Saving\u2026',

  // Translators: Property create forms (Settings › Properties, add-property popover, Change type):
  // placeholder of the options box of a select, and the "several values" checkbox.
  // severalValuesType = type badge, {{type}} = an English type code like "select".
  'properties.newSelectOptions': 'Options, comma-separated',
  'properties.holdsSeveralValues': 'Holds several values',
  'properties.severalValuesType': '{{type}} · several values',

  // Translators: Tags view: short label on the divider between the tag list and the tag filter.
  'tagFilter.sectionLabel': 'Filter',

  // Translators: Tags view, tag filter panel (find blocks carrying tags): heading, intro, the tag
  // search box (placeholder + screen-reader label), and the selected-tag pills ({{name}} = tag).
  'tagFilter.title': 'Find blocks by tag',
  'tagFilter.description': 'Pick one or more tags to list the blocks that carry them.',
  'tagFilter.searchPlaceholder': 'Find a tag…',
  'tagFilter.searchLabel': 'Find a tag',
  'tagFilter.selectedLabel': 'Selected:',
  'tagFilter.removeTagLabel': 'Remove tag {{name}}',

  // Translators: Tag filter mode toggle: label "Show blocks with:" then short buttons All (every
  // selected tag) / Any (at least one); their tooltips explain. The third, None, is further down.
  'tagFilter.modeLabel': 'Show blocks with:',
  'tagFilter.andMode': 'All',
  'tagFilter.andModeTooltip': 'Every selected tag',
  'tagFilter.orMode': 'Any',
  'tagFilter.orModeTooltip': 'At least one selected tag',
  'tagFilter.selectTagsMessage': 'Select tags above to filter blocks',

  // Translators: Tag filter feedback line: prompt before any tag is chosen, and the match count.
  'tagFilter.blockMatch_one': '{{count}} block matches',
  'tagFilter.blockMatch_other': '{{count}} blocks match',

  // Translators: Tag filter: list of tags matching the typed search, each with an "Add" button.
  'tagFilter.matchingTagsTitle': 'Matching tags',
  'tagFilter.addButton': 'Add',

  // Translators: Tag filter results: empty text, "Results" heading (the count follows in
  // parentheses), "(empty)" for a block with no text, loading text and the Load more button.
  'tagFilter.noMatchesFound': 'No matching blocks found.',
  'tagFilter.resultsTitle': 'Results',
  'tagFilter.emptyContent': '(empty)',
  'tagFilter.loadingMessage': 'Loading...',
  'tagFilter.loadMoreButton': 'Load more',

  // Translators: Tag filter match count once tags are chosen, as in "3 blocks match 2 tags (All)".
  // {{count}} = matching blocks; {{tags}} = the tagCount text below ("2 tags"); {{mode}} = the
  // chosen mode button (All / Any / None).
  'tagFilter.blockMatchTags_one': '{{count}} block matches {{tags}} ({{mode}})',
  'tagFilter.blockMatchTags_other': '{{count}} blocks match {{tags}} ({{mode}})',
  'tagFilter.tagCount_one': '{{count}} tag',
  'tagFilter.tagCount_other': '{{count}} tags',

  // Translators: Tag filter prefix pills: "Starts with" button adds the typed text as a prefix
  // (its screen-reader label explains); pills read "{{prefix}}*", where * means "any ending".
  // #1426 — prefix-search pills
  'tagFilter.addPrefixButton': 'Starts with',
  'tagFilter.addPrefixLabel': 'Starts with the typed text: match every tag that begins with it',
  'tagFilter.prefixesLabel': 'Starts with:',
  'tagFilter.prefixPillLabel': '{{prefix}}*',
  'tagFilter.removePrefixLabel': 'Remove prefix {{prefix}}',

  // Translators: Tag filter switch "Include nested blocks", its tooltip, and the note appended to
  // the match count while it is on. "inline @ tag chip" = a tag typed in a block's text.
  // #4548 — the "Include nested blocks" switch. One flag for the whole query
  // (`query_by_tags` / `query_by_tag_expr` take a single `include_inherited`),
  // default off so an existing query keeps its result set.
  'tagFilter.includeInherited': 'Include nested blocks',
  'tagFilter.includeInheritedTooltip':
    "Also match blocks nested under a tagged block. A tag on a block applies to every block beneath it, however deep — a tag on a page's first block matches the whole page. Only tags added to a block are inherited; an inline @ tag chip in its text is not.",
  'tagFilter.includingInherited': '(including nested blocks)',

  // Translators: Tag filter toggle button: reads "Advanced" to open the nested AND / OR composer,
  // "Simple" to go back to the flat filter.
  // #1426 — nested And/Or/Not composer (#1472 query_by_tag_expr IPC)
  'tagFilter.composer.show': 'Advanced',
  'tagFilter.composer.hide': 'Simple',

  // Translators: Tag filter composer (nested groups of tags): screen-reader group names, the
  // "Combine with" All / Any toggle, the NOT toggle (short, capitals), and short "Tag" / "Group"
  // add buttons. {{label}} = a tag name or a prefix like "proj*".
  'tagFilter.composer.rootLabel': 'Tag query group',
  'tagFilter.composer.groupLabel': 'Nested tag query group',
  'tagFilter.composer.opLabel': 'Combine with',
  'tagFilter.composer.opAnd': 'All',
  'tagFilter.composer.opOr': 'Any',
  'tagFilter.composer.notLabel': 'NOT',
  'tagFilter.composer.negateLeaf': 'Negate {{label}} (NOT)',
  'tagFilter.composer.negateGroup': 'Negate this group (NOT)',
  'tagFilter.composer.addTag': 'Tag',
  'tagFilter.composer.addGroup': 'Group',
  'tagFilter.composer.removeGroup': 'Remove this group',
  'tagFilter.composer.removeGroupButton': 'Remove group',
  'tagFilter.composer.removeLeaf': 'Remove {{label}}',

  // Translators: Composer: empty-group hint, prefix chip "{{prefix}}*" (keep the *), the tag search
  // box (placeholder + screen-reader label), and the option adding the typed text as a prefix.
  'tagFilter.composer.emptyGroup': 'Add tags, name-prefixes, or a nested group to filter by.',
  'tagFilter.composer.prefixLeafLabel': '{{prefix}}*',
  'tagFilter.composer.searchPlaceholder': 'Find a tag…',
  'tagFilter.composer.searchLabel': 'Search tags to add',
  'tagFilter.composer.addPrefixOption': 'Add prefix "{{prefix}}*"',

  // Translators: Linked references section of a page: filter icon button opening a list of the
  // pages the references come from (search box, empty text, "Clear all" button).
  'sourceFilter.filterLabel': 'Filter by source page',
  'sourceFilter.searchPlaceholder': 'Search pages...',
  'sourceFilter.searchLabel': 'Search source pages',
  'sourceFilter.noPagesFound': 'No pages found',
  'sourceFilter.clearAllButton': 'Clear all',

  // Translators: Property chip on a block ("key: value"): toast when renaming its key fails,
  // screen-reader label of the key button (renames the key), and the chip's screen-reader label.
  'property.renameFailed': 'Failed to rename property',
  'property.editKeyLabel': 'Edit property {{key}}',
  'property.selectValue': '{{key}}: {{value}}',

  // Translators: Tag filter mode toggle: third button (blocks with none of the tags) and tooltip.
  'tagFilter.notMode': 'None',
  'tagFilter.notModeTooltip': 'None of the selected tags',

  // Translators: BlockPropertyDrawer: screen-reader announcements after a change.
  'property.saved': 'Property saved',
  'property.deleted': 'Property deleted',
  'property.dateCleared': 'Date cleared',
  'property.dateUpdated': 'Date updated',

  // Translators: Tag filter result card: label before the page link, as in "in: My Page".
  'tagFilter.inPage': 'in:',

  // Translators: Date fields of properties: placeholder listing input examples, and status lines
  // under the field. The date reader understands English only: keep the examples as they are.
  'property.datePlaceholder': 'today, +3d, Apr 15, 2025-04-15',
  'property.dateParseError': 'Could not parse date',
  'property.dateParsing': 'Parsing…',

  // Translators: Help popover beside the "repeat" property field (recurring tasks): screen-reader
  // labels of its button and popover, its title, and the two rule prefixes it explains
  // ("++", ".+").
  'property.repeatHelpLabel': 'Repeat syntax help',
  'property.repeatHelpTitle': 'Repeat syntax',
  'property.repeatHelpCatchup': 'Reschedule from the original date plus the interval (catch-up).',
  'property.repeatHelpFromCompletion': 'Reschedule from the moment of completion.',
  // #3647 — this example used to read `++ 1d` / `.+ 1w`, WITH a space. The
  // recurrence parser has never accepted a space inside the interval (`++ 1d`
  // splits to the interval `" 1d"`, whose count fails to parse), so the app's
  // own help text taught a rule that silently did nothing. Now that the
  // grammar is enforced at `set_property`, the copy must be a rule that works.
  // Translators: Keep `++1d` and `.+1w` exactly: they are the syntax to type.
  'property.repeatHelpExample':
    'Example: `++1d` repeats daily catching up; `.+1w` waits a week from when you marked it done.',
  'property.repeatHelpPopoverLabel': 'Repeat syntax help',

  // Translators: Linked references filters: words combined into each filter pill, e.g. "due is
  // set" or 'tag prefix "proj"'. Lowercase, mid-phrase; "filter" = generic pill text.
  'filter.operatorContains': 'contains',
  'filter.operatorStartsWith': 'starts with',
  'filter.isSet': 'is set',
  'filter.isEmpty': 'is empty',
  'filter.tagPrefix': 'tag prefix',
  'filter.default': 'filter',

  // Translators: More filter-pill words, e.g. "status = TODO", "created after 2025-01-01",
  // "has tag work". Lowercase.
  // #2232 — dimension nouns + chip aria-labels routed through i18n so applied
  // filter pills no longer render mixed-language under a non-English locale.
  'filter.summary.type': 'type',
  'filter.summary.status': 'status',
  'filter.summary.priority': 'priority',
  'filter.summary.hasTag': 'has tag',
  'filter.summary.created': 'created',
  'filter.summary.after': 'after',
  'filter.summary.before': 'before',

  // Translators: Filter pill screen-reader labels; {{summary}} = the pill text.
  'filter.remove': 'Remove filter {{summary}}',
  'filter.group': 'Filter: {{summary}}',

  // Translators: Linked references and search results: screen-reader label and tooltip of a page
  // group's chevron button.
  'group.collapseGroup': 'Collapse group',
  'group.expandGroup': 'Expand group',

  // Translators: Selection toolbar of Trash, History and Pages: hint about range selection.
  'list.rangeSelectHint': 'Tip: Shift+click to select a range',

  // Translators: Query block: screen-reader name of its results list.
  'query.resultsListLabel': 'Query results',

  // Translators: Query block table: screen-reader label of a column header that sorts by that
  // column. {{column}} = column name.
  'queryResult.sortBy': 'Sort by {{column}}',
  // #3315 item 3 — accessible name for the same header when more pages remain
  // unloaded: the sort is over the loaded rows, not the column.
  'queryResult.sortByPartial': 'Sort by {{column}} (loaded rows only)',

  // Translators: Query block table cells (task state, properties): screen-reader label of an
  // editable cell ({{column}} = column name, {{value}} = its value), and the toast after an edit.
  'queryResult.cell.edit': 'Edit {{column}}: {{value}}',
  'queryResult.cell.set': 'Set {{column}}',
  'queryResult.cell.updated': '{{column}} updated',

  // Translators: Query block table: column picker button (screen-reader label), move up / down
  // buttons per column, and a button going back to columns taken from the results.
  'queryResult.columns.trigger': 'Choose columns',
  'queryResult.columns.moveUp': 'Move {{column}} up',
  'queryResult.columns.moveDown': 'Move {{column}} down',
  'queryResult.columns.automatic': 'Columns from the results',

  // Translators: Agenda, add-filter menu: tooltip describing each filter type. Keep TODO, DOING,
  // DONE, CANCELLED and "#tag" as they are.
  'filter.dimension.status.description': 'Task workflow state — TODO, DOING, DONE, CANCELLED',
  'filter.dimension.priority.description': 'Priority level — A (highest) through C',
  'filter.dimension.dueDate.description': 'Hard due date — overdue if past',
  'filter.dimension.scheduledDate.description': 'Soft scheduled start — not overdue if past',
  'filter.dimension.completedDate.description': 'When the task was marked DONE or CANCELLED',
  'filter.dimension.createdDate.description': 'When the block was first created',
  'filter.dimension.tag.description': 'Match blocks carrying a specific #tag',
  'filter.dimension.property.description': 'Match a custom property key/value pair',
}
