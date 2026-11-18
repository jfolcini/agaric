/**
 * Every shipped locale against the English source (#4555). Locales come from
 * the registry, so a new one is held to this the moment it is registered.
 *
 * A base locale (`es`, `pt`) is COMPLETE: it carries every English key. A
 * string added to English without its translations fails here, so new copy
 * lands translated or not at all. A regional variant (`pt-PT` over `pt`)
 * carries only the keys whose wording differs from its base; i18next
 * resolves the rest through the base.
 *
 * Every key a locale does carry:
 *   1. exists in English — a key only Spanish has is a typo, and renders the
 *      raw key in every other language;
 *   2. keeps English's `{{…}}` placeholders, as a multiset — a dropped or
 *      renamed `{{count}}` renders literally;
 *   3. keeps English's inline tags (`<strong>`, `<m0/>`) — `Trans` maps them
 *      to elements, so a lost tag loses its element;
 *   4. is not blank;
 *   5. is not a byte-copy of the English — a pasted English value passes the
 *      completeness check and ships English. Exempt: a value with nothing to
 *      translate (no lowercase letter outside its placeholders: a symbol, an
 *      acronym, a task keyword), `ENGLISH_IN_EVERY_LOCALE`, and the locale's
 *      `SAME_AS_ENGLISH` words.
 *
 * Plurals: a locale carries a `_<category>` form for each of ITS CLDR plural
 * categories (`Intl.PluralRules`), not English's `_one`/`_other`. It may skip
 * a category in `OPTIONAL_PLURAL_CATEGORIES`.
 */

import { describe, expect, it } from 'vitest'

import { i18n } from '@/lib/i18n'
import { ENGLISH_IN_EVERY_LOCALE } from '@/lib/i18n/english-in-every-locale'
import {
  baseLocale,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@/lib/i18n/locales'
import { loadLocale } from '@/lib/i18n/set-locale'

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/
const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g
const TAG_RE = /<\/?[a-zA-Z0-9]+\s*\/?>/g

/**
 * Plural categories a locale may leave out. CLDR gives Spanish, French and
 * Portuguese a `many` form for exact millions only ("1 000 000 de bloques");
 * when it is missing, i18next renders the `_other` form in the same language,
 * so the gap costs a "de", never a fall back to English.
 */
const OPTIONAL_PLURAL_CATEGORIES: Partial<Record<SupportedLocale, readonly string[]>> = {
  es: ['many'],
  fr: ['many'],
  pt: ['many'],
}

/** Per locale, keys whose value is a word the language spells as English does. */
const SAME_AS_ENGLISH: Partial<Record<SupportedLocale, readonly string[]>> = {
  de: [
    'advancedQuery.aggregate.op.max',
    'advancedQuery.aggregate.op.min',
    'advancedQuery.aggregate.target.position',
    'advancedQuery.builder.rootLabel',
    'advancedQuery.sort.column.position',
    'advancedQuery.view.board',
    'agendaFilter.group.organisation',
    'agendaFilter.status',
    'agendaFilter.tag',
    'agentAccess.agents.nameLabel',
    'backlink.statusOption',
    'backlink.tagLabel',
    'backlink.tagType',
    'backlink.textType',
    'callout.info',
    'duePanel.duePanelLabel',
    'editor.suggestion.tags',
    'filter.group',
    'graph.filter.status',
    'graph.filter.tagPlural',
    'history.filterLabel',
    'integrity.table.agenda',
    'journal.agendaTab',
    'keyboard.category.global',
    'keyboard.category.journal',
    'keyboard.category.tabs',
    'markdownReference.emoji.title',
    'markdownReference.group.text',
    'markdownReference.link.title',
    'markdownReference.tag.title',
    'metadata.label',
    'pageBrowser.filter.blockType.tag',
    'pageBrowser.filter.facetTag',
    'pageBrowser.filter.filterGroup',
    'pageBrowser.savedViews.nameLabel',
    'pairing.passphraseLabel',
    'palette.modeTags',
    'palette.tagsTitle',
    'query.column.status',
    'queryBuilder.propertyOperator',
    'queryBuilder.type.backlinks',
    'search.filterGroupLabel',
    'settings.tabEditor',
    'settings.zoomLabel',
    'shortcuts.syntaxSection',
    'sidebar.graph',
    'sidebar.journal',
    'sidebar.offline',
    'sidebar.tags',
    'status.syncOffline',
    'tagFilter.composer.addTag',
    'tagFilter.inPage',
    'tagFilter.sectionLabel',
    'tagList.color.orange',
    'toolbar.emoji',
    'toolbar.tag',
    'toolbar.tagTip',
  ],
  es: [
    'attachment.audioLabel',
    'bugReport.logsSize',
    'callout.error',
    'dialog.no',
    'duePanel.duePanelLabel',
    'graph.filter.no',
    'integrity.table.agenda',
    'journal.agendaTab',
    'keyboard.category.global',
    'markdownReference.emoji.title',
    'meeting.audioLabel',
    'newPageDialog.aliasOf',
    'pdfViewer.error',
    'property.booleanFalse',
    'settings.tabEditor',
    'settings.tabGeneral',
    'settings.zoomLabel',
    'status.syncError',
    'toolbar.emoji',
    'trash.noButton',
  ],
  fr: [
    'advancedQuery.aggregate.op.max',
    'advancedQuery.aggregate.op.min',
    'advancedQuery.aggregate.target.position',
    'advancedQuery.group.dateBucket',
    'advancedQuery.group.page',
    'advancedQuery.sort.column.position',
    'agenda.groupDate',
    'agenda.groupPage',
    'agenda.sortDate',
    'agenda.sortPage',
    'agendaFilter.group.dates',
    'agendaFilter.group.organisation',
    'agentAccess.agents.title',
    'backlink.dateType',
    'backlink.pageType',
    'data.importResultNotesTitle_one',
    'data.importResultNotesTitle_other',
    'duePanel.duePanelLabel',
    'editor.suggestion.fallback',
    'errorBoundary.section.notifications',
    'filter.summary.type',
    'integrity.table.agenda',
    'journal.agendaTab',
    'journal.legendPage',
    'keyboard.actionHeader',
    'keyboard.category.global',
    'keyboard.category.journal',
    'keyboard.category.navigation',
    'keyboard.descriptionHeader',
    'markdownReference.emoji.title',
    'markdownReference.image.title',
    'meeting.dateLabel',
    'pageBrowser.countAll_one',
    'pageBrowser.countAll_other',
    'pageBrowser.filter.blockType.page',
    'pageBrowser.filter.dateLabel',
    'pageBrowser.filter.dateOpLabel',
    'pageBrowser.filter.pagesGroup',
    'pageBrowser.pagesSection',
    'pageBrowser.pagesSectionLabel_one',
    'pageBrowser.pagesSectionLabel_other',
    'pageMode.page',
    'pageProperty.dateType',
    'palette.cmdGroupAction',
    'pdfViewer.source',
    'pdfViewer.sourceUnknown',
    'properties.optionsCount_one',
    'properties.optionsCount_other',
    'propertiesView.createType',
    'property.datetimeDateLabel',
    'property.effort',
    'query.column.page',
    'queryBuilder.mode.simple',
    'search.filterHelper.dateValueLabel',
    'search.help.toggles.col.mode',
    'search.pageCount_one',
    'search.pageCount_other',
    'search.replace.pages_one',
    'search.replace.pages_other',
    'settings.editor.editModePage',
    'sidebar.journal',
    'sidebar.pages',
    'slashCommand.categories.dates',
    'slashCommand.categories.structure',
    'tagFilter.composer.hide',
    'tagList.color.orange',
    'tagList.color.rose',
    'tagList.color.violet',
    'taggedItems.pages',
    'toolbar.emoji',
  ],
  pt: [
    'agendaFilter.status',
    'backlink.statusOption',
    'bugReport.logsSize',
    'duePanel.duePanelLabel',
    'filter.summary.status',
    'graph.filter.status',
    'integrity.table.agenda',
    'journal.agendaTab',
    'journal.refsBadge',
    'keyboard.category.global',
    'markdownReference.emoji.title',
    'markdownReference.link.title',
    'newPageDialog.aliasOf',
    'pageProperty.urlType',
    'pdfViewer.source',
    'pdfViewer.sourceUnknown',
    'query.column.status',
    'queryBuilder.type.backlinks',
    'search.help.toggles.mode.regex',
    'search.toggle.regex',
    'settings.tabEditor',
    'settings.zoomLabel',
    'toolbar.emoji',
  ],
}

function hasNothingToTranslate(value: string): boolean {
  return !/\p{Ll}/u.test(value.replace(PLACEHOLDER_RE, ''))
}

const en = i18n.getResourceBundle(DEFAULT_LOCALE, 'translation') as Record<string, string>
const enPluralBases = new Set(
  Object.keys(en)
    .filter((key) => PLURAL_SUFFIX_RE.test(key))
    .map((key) => key.replace(PLURAL_SUFFIX_RE, '')),
)

for (const tag of SUPPORTED_LOCALES) await loadLocale(tag)

function catalogOf(tag: SupportedLocale): Record<string, string> {
  return i18n.getResourceBundle(tag, 'translation') as Record<string, string>
}

function pluralCategories(tag: SupportedLocale): string[] {
  return new Intl.PluralRules(tag).resolvedOptions().pluralCategories
}

/** The English string `key` translates: the key itself, or a plural form's English `_other`. */
function englishSource(tag: SupportedLocale, key: string): string | undefined {
  if (Object.hasOwn(en, key)) return en[key]
  const category = PLURAL_SUFFIX_RE.exec(key)?.[1]
  const base = key.replace(PLURAL_SUFFIX_RE, '')
  if (category === undefined || !enPluralBases.has(base)) return undefined
  return pluralCategories(tag).includes(category) ? en[`${base}_other`] : undefined
}

/** Every key a complete catalog for `tag` carries. */
function requiredKeys(tag: SupportedLocale): string[] {
  const optional = OPTIONAL_PLURAL_CATEGORIES[tag] ?? []
  const categories = pluralCategories(tag).filter((c) => !optional.includes(c))
  return [
    ...Object.keys(en).filter((key) => !PLURAL_SUFFIX_RE.test(key)),
    ...[...enPluralBases].flatMap((base) => categories.map((c) => `${base}_${c}`)),
  ]
}

function multiset(value: string, re: RegExp): string[] {
  return [...value.matchAll(re)].map((m) => m[0].replace(/\s+/g, '')).toSorted()
}

function failWith(problem: string, lines: readonly string[]): void {
  if (lines.length === 0) return
  const shown = lines.slice(0, 60).map((line) => `  - ${line}`)
  if (lines.length > shown.length) shown.push(`  … and ${lines.length - shown.length} more`)
  expect.fail(`${lines.length} ${problem}:\n${shown.join('\n')}`)
}

describe.each(SUPPORTED_LOCALES.filter((tag) => tag !== DEFAULT_LOCALE))(
  'the %s catalog',
  (tag) => {
    const catalog = catalogOf(tag)
    const entries = Object.entries(catalog)
    const isVariant = baseLocale(tag) !== tag

    it.skipIf(isVariant)('carries every English key', () => {
      const missing = requiredKeys(tag).filter((key) => !Object.hasOwn(catalog, key))
      failWith(
        `key(s) missing from "${tag}" — add each to src/lib/i18n/${tag}/<namespace>.ts, ` +
          'the file named like the English one that defines it',
        missing,
      )
    })

    it('carries no key English lacks', () => {
      const extra = entries
        .map(([key]) => key)
        .filter((key) => englishSource(tag, key) === undefined)
      failWith(`key(s) in "${tag}" that English does not define`, extra)
    })

    it('keeps every English placeholder and inline tag', () => {
      const drifted = entries.flatMap(([key, value]) => {
        const source = englishSource(tag, key)
        if (source === undefined) return []
        return [PLACEHOLDER_RE, TAG_RE]
          .filter((re) => multiset(value, re).join(' ') !== multiset(source, re).join(' '))
          .map(
            (re) =>
              `${key}: [${multiset(value, re).join(' ')}] ≠ en [${multiset(source, re).join(' ')}]`,
          )
      })
      failWith(`value(s) in "${tag}" whose placeholders or tags differ from English`, drifted)
    })

    it('has no blank value', () => {
      failWith(
        `blank value(s) in "${tag}"`,
        entries.filter(([, value]) => value.trim() === '').map(([key]) => key),
      )
    })

    it('translates every value it carries', () => {
      const allowed = new Set([...ENGLISH_IN_EVERY_LOCALE, ...(SAME_AS_ENGLISH[tag] ?? [])])
      const copies = entries
        .filter(([key, value]) => value === englishSource(tag, key))
        .filter(([key, value]) => !allowed.has(key) && !hasNothingToTranslate(value))
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      failWith(
        `value(s) in "${tag}" identical to English — translate them, or list a word the ` +
          'language spells the same in SAME_AS_ENGLISH',
        copies,
      )
    })

    it('keeps the English of every ENGLISH_IN_EVERY_LOCALE key', () => {
      const changed = ENGLISH_IN_EVERY_LOCALE.filter(
        (key) => Object.hasOwn(catalog, key) && catalog[key] !== en[key],
      ).map((key) => `${key} = ${JSON.stringify(catalog[key])}, en ${JSON.stringify(en[key])}`)
      failWith(`value(s) in "${tag}" that must stay English`, changed)
    })

    it('lists in SAME_AS_ENGLISH only keys that still match English', () => {
      const stale = (SAME_AS_ENGLISH[tag] ?? []).filter(
        (key) => catalog[key] === undefined || catalog[key] !== englishSource(tag, key),
      )
      failWith(`stale SAME_AS_ENGLISH entr(y/ies) for "${tag}" — remove them`, stale)
    })
  },
)
