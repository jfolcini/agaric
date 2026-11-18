/**
 * Keys every locale must keep in English, because a parser or the platform
 * reads their values. `locale-catalogs.test.ts` fails a translation of one,
 * and the pseudo-locale (`src/lib/i18n/en-XA/index.ts`) leaves them as they are.
 */
export const ENGLISH_IN_EVERY_LOCALE: readonly string[] = [
  // `aria-keyshortcuts` values: assistive tech parses the key names.
  'block.reorderKeyshortcuts',
  'block.collapseKeyshortcuts',
  // Example input for `parse-date.ts`, which reads English words only.
  'dateChip.placeholder',
  'property.datePlaceholder',
  // Literal examples, notation, and names.
  'search.filterHelper.pathPlaceholder',
  'linkEdit.urlPlaceholder',
  'advancedQuery.aggregate.contributingCount',
  'agentAccess.agents.namePlaceholder',
  'data.importEnexLabel',
  'data.importJexLabel',
  'referenceSheet.markdown.title',
  'settings.themeDracula',
  'settings.themeOneDarkPro',
]
