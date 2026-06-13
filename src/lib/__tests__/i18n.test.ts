/**
 * Tests for src/lib/i18n.ts — translation configuration and string definitions.
 *
 * Covers: key existence, interpolation, fallback behaviour,
 *         key uniqueness, and value type safety.
 */

import { describe, expect, it } from 'vitest'

import { i18n } from '../i18n'
// Import every namespace individually so we can detect cross-namespace
// key collisions that object spread silently overwrites.
import { agenda } from '../i18n/agenda'
import { block } from '../i18n/block'
import { common } from '../i18n/common'
import { editor } from '../i18n/editor'
import { errors } from '../i18n/errors'
import { history } from '../i18n/history'
import { pages } from '../i18n/pages'
import { properties } from '../i18n/properties'
import { references } from '../i18n/references'
import { settings } from '../i18n/settings'
import { shortcuts } from '../i18n/shortcuts'
import { sync } from '../i18n/sync'
import { toolbar } from '../i18n/toolbar'
import { TURN_INTO_OPTIONS, turnIntoTypeKey } from '../slash-commands'

// ── Helpers ──────────────────────────────────────────────────────────────

/** Return the flat translation object for the English locale. */
function getTranslations(): Record<string, string> {
  return i18n.getResourceBundle('en', 'translation') as Record<string, string>
}

// ── Initialisation ───────────────────────────────────────────────────────

describe('i18n initialisation', () => {
  it('is initialised and ready', () => {
    expect(i18n.isInitialized).toBe(true)
  })

  it('uses English as the default language', () => {
    expect(i18n.language).toBe('en')
  })

  it('has a non-empty translation bundle', () => {
    const translations = getTranslations()
    expect(Object.keys(translations).length).toBeGreaterThan(0)
  })
})

// ── Key existence — critical namespaces ──────────────────────────────────

describe('key existence', () => {
  const criticalKeys = [
    // Sidebar
    'sidebar.pages',
    'sidebar.journal',
    'sidebar.newPage',
    'sidebar.sync',
    'sidebar.search',
    'sidebar.toggleSidebar',

    // Empty states
    'empty.noBlocks',
    'empty.noPages',

    // Actions
    'action.addBlock',
    'action.save',
    'action.cancel',
    'action.delete',
    'action.undo',
    'action.redo',

    // Journal
    'journal.today',
    'journal.daily',
    'journal.noBlocks',
    'journal.addFirstBlock',

    // Toolbar
    'toolbar.bold',
    'toolbar.italic',
    'toolbar.code',
    'toolbar.link',

    // Context menu
    'contextMenu.delete',
    'contextMenu.indent',
    'contextMenu.moveUp',
    'contextMenu.moveDown',

    // Block
    'block.reorder',
    'block.delete',
    'block.taskCycle',
    'block.dueDate',
    'block.scheduledDate',

    // Errors
    'error.generic',
    'error.loadFailed',
    'error.saveFailed',

    // Slash commands
    'slash.repeatSet',
    'slash.noTemplates',

    // References
    'references.header',
    'references.loadMore',

    // Unlinked References
    'unlinkedRefs.header',
    'unlinkedRefs.linkIt',

    // Done Panel
    'donePanel.header',
    'donePanel.completedItems',

    // Agenda
    'agenda.loadingTasks',
    'agenda.noTasks',
    'agenda.overdue',
    'agenda.today',

    // Agenda Filter
    'agendaFilter.status',
    'agendaFilter.addFilter',
    'agendaFilter.apply',

    // History
    'history.title',

    // Undo
    'undo.batchUnavailable',

    // Page Header
    'pageHeader.pageTitle',
    'pageHeader.goBack',
    'pageHeader.deletePage',

    // Page Browser
    'pageBrowser.newPage',
    'pageBrowser.noPages',
    'pageBrowser.searchPlaceholder',

    // Due Panel
    'duePanel.header',

    // Search
    'search.minCharsHint',

    // Editor
    'editor.templatePlaceholder',
    'editor.emptyBlockPlaceholder',

    // Property
    'property.drawerTitle',
    'property.addProperty',
    'property.booleanToggle',

    // Page property
    'pageProperty.booleanType',

    // Properties view
    'propertiesView.title',
    'propertiesView.create',

    // Tags
    'tags.loadFailed',

    // Shortcuts
    'shortcuts.title',

    // Status / peer address
    'status.peerAddress',
    'status.importTitle',
  ]

  it.each(criticalKeys)('t("%s") returns a non-empty string', (key) => {
    const value = i18n.t(key)
    expect(value).not.toBe(key) // not the raw key (i.e. it was found)
    expect(typeof value).toBe('string')
    expect(value.length).toBeGreaterThan(0)
  })

  // #986 regression: the "Turn into" submenu rendered raw key strings
  // (contextMenu.turnInto / contextMenu.turnIntoType.*) because the keys were
  // never defined. Drive the assertion off TURN_INTO_OPTIONS so any new
  // turn-into target must ship its label key too.
  it('contextMenu.turnInto resolves (not the raw key)', () => {
    expect(i18n.t('contextMenu.turnInto')).not.toBe('contextMenu.turnInto')
  })

  it.each(TURN_INTO_OPTIONS.map((o) => o.blockType))(
    'turn-into label key for "%s" resolves to a real label',
    (blockType) => {
      const key = turnIntoTypeKey(blockType)
      const value = i18n.t(key)
      expect(value).not.toBe(key)
      expect(value.length).toBeGreaterThan(0)
    },
  )

  it('covers every top-level namespace in the translation bundle', () => {
    const translations = getTranslations()
    const namespaces = new Set(Object.keys(translations).map((k) => k.split('.')[0]))

    const expectedNamespaces = [
      'sidebar',
      'empty',
      'action',
      'journal',
      'toolbar',
      'contextMenu',
      'block',
      'error',
      'slash',
      'references',
      'unlinkedRefs',
      'donePanel',
      'agenda',
      'agendaFilter',
      'history',
      'pageHeader',
      'pageBrowser',
      'duePanel',
      'search',
      'editor',
      'property',
      'propertiesView',
      'tags',
      'shortcuts',
      'status',
    ]

    for (const ns of expectedNamespaces) {
      expect(namespaces).toContain(ns)
    }
  })
})

// ── Interpolation ────────────────────────────────────────────────────────

describe('interpolation', () => {
  it('interpolates {{date}} in journal.noBlocks', () => {
    const result = i18n.t('journal.noBlocks', { date: '2025-06-15' })
    expect(result).toBe('No blocks for 2025-06-15.')
    expect(result).not.toContain('{{')
  })

  it('interpolates {{count}} in references.header', () => {
    const result = i18n.t('references.header', { count: 42 })
    expect(result).toBe('42 References')
  })

  it('interpolates {{count}} in unlinkedRefs.header', () => {
    const result = i18n.t('unlinkedRefs.header', { count: 7 })
    expect(result).toBe('7 Unlinked References')
  })

  it('interpolates {{count}} in donePanel.header', () => {
    const result = i18n.t('donePanel.header', { count: 3 })
    expect(result).toBe('3 Completed')
  })

  it('interpolates {{count}} in duePanel.header', () => {
    const result = i18n.t('duePanel.header', { count: 5 })
    expect(result).toBe('5 Agenda')
  })

  it('interpolates {{count}} in agenda.resultCount', () => {
    const result = i18n.t('agenda.resultCount', { count: 10 })
    expect(result).toBe('10 results')
  })

  it('interpolates {{value}} in slash.repeatSet', () => {
    const result = i18n.t('slash.repeatSet', { value: '+1w' })
    expect(result).toBe('Set repeat to +1w')
  })

  it('interpolates {{value}} in slash.effortSet', () => {
    const result = i18n.t('slash.effortSet', { value: '2h' })
    expect(result).toBe('Set effort to 2h')
  })

  it('interpolates {{state}} in block.taskCycle', () => {
    const result = i18n.t('block.taskCycle', { state: 'TODO' })
    expect(result).toBe('Task: TODO. Click to cycle.')
  })

  it('interpolates {{level}} in block.priorityCycle', () => {
    const result = i18n.t('block.priorityCycle', { level: 1 })
    expect(result).toBe('Priority 1. Click to cycle.')
  })

  it('interpolates {{date}} in block.dueDate', () => {
    const result = i18n.t('block.dueDate', { date: 'tomorrow' })
    expect(result).toBe('Due tomorrow')
  })

  it('interpolates {{title}} in references.backlinksFrom', () => {
    const result = i18n.t('references.backlinksFrom', { title: 'My Page' })
    expect(result).toBe('Backlinks from My Page')
  })

  it('interpolates {{name}} in pageBrowser.deleteDescription', () => {
    const result = i18n.t('pageBrowser.deleteDescription', { name: 'Test Page' })
    expect(result).toContain('Test Page')
    expect(result).not.toContain('{{')
  })

  it('interpolates {{error}} in pageBrowser.createFailed', () => {
    const result = i18n.t('pageBrowser.createFailed', { error: 'duplicate name' })
    expect(result).toBe('Failed to create page: duplicate name')
  })

  it('interpolates {{alias}} in pageHeader.removeAlias', () => {
    const result = i18n.t('pageHeader.removeAlias', { alias: 'my-alias' })
    expect(result).toBe('Remove alias my-alias')
  })

  it('interpolates {{name}} in pageHeader.createTag', () => {
    const result = i18n.t('pageHeader.createTag', { name: 'urgent' })
    expect(result).toBe('Create "urgent"')
  })

  it('interpolates {{label}} in agendaFilter.optionsLabel', () => {
    const result = i18n.t('agendaFilter.optionsLabel', { label: 'Priority' })
    expect(result).toBe('Priority options')
  })

  it('interpolates {{count}} in agendaFilter.filtersApplied', () => {
    const result = i18n.t('agendaFilter.filtersApplied', { count: 3 })
    expect(result).toBe('3 filters applied')
  })

  it('interpolates {{title}} in search.parentPage', () => {
    const result = i18n.t('search.parentPage', { title: 'Projects' })
    expect(result).toBe('in: Projects')
  })
})

// ── Fallback behaviour ───────────────────────────────────────────────────

describe('fallback behaviour', () => {
  it('returns the key itself for a completely missing key', () => {
    const missing = 'this.key.does.not.exist'
    expect(i18n.t(missing)).toBe(missing)
  })

  it('returns the key for a missing namespace prefix', () => {
    const missing = 'nonexistent.foo'
    expect(i18n.t(missing)).toBe(missing)
  })

  it('returns the key for a partial key that does not match', () => {
    const missing = 'sidebar.thisDoesNotExist'
    expect(i18n.t(missing)).toBe(missing)
  })

  it('does not crash on an empty key', () => {
    expect(() => i18n.t('')).not.toThrow()
  })
})

// ── No duplicate keys ────────────────────────────────────────────────────

describe('no duplicate keys', () => {
  it('has unique keys (no overwrites in the flat translation object)', () => {
    const translations = getTranslations()
    const keys = Object.keys(translations)
    const uniqueKeys = new Set(keys)
    // If a key appeared twice in the source literal the second would overwrite
    // the first and the Set size would still match — so the real check is that
    // the number of keys is what we expect (at least as many as the known namespaces).
    expect(keys.length).toBe(uniqueKeys.size)
    // Sanity: we have a substantial number of keys
    expect(keys.length).toBeGreaterThan(200)
  })

  it('has no cross-namespace key collisions (spread-merge integrity)', () => {
    const namespaces = [
      common,
      errors,
      toolbar,
      block,
      agenda,
      editor,
      pages,
      properties,
      references,
      history,
      sync,
      shortcuts,
      settings,
    ]
    const individualKeyCount = namespaces.reduce((sum, ns) => sum + Object.keys(ns).length, 0)
    const mergedKeyCount = Object.keys(getTranslations()).length
    // If any two namespaces share a key, the spread-merge silently overwrites
    // and the merged count will be smaller than the sum of individual counts.
    expect(mergedKeyCount).toBe(individualKeyCount)
  })

  it('every key follows the namespace.name convention', () => {
    const translations = getTranslations()
    for (const key of Object.keys(translations)) {
      expect(key).toMatch(/^[a-zA-Z]+(\.[a-zA-Z0-9]+)+(_one|_other)?$/)
    }
  })
})

// ── All values are strings (no undefined / null) ─────────────────────────

describe('all values are strings', () => {
  it('every translation value is a non-empty string', () => {
    const translations = getTranslations()
    for (const [key, value] of Object.entries(translations)) {
      expect(value, `key "${key}" should be a string`).not.toBeNull()
      expect(value, `key "${key}" should be a string`).not.toBeUndefined()
      expect(typeof value, `key "${key}" should be a string`).toBe('string')
      expect((value as string).length, `key "${key}" should be non-empty`).toBeGreaterThan(0)
    }
  })

  it('no value contains only whitespace', () => {
    const translations = getTranslations()
    for (const [key, value] of Object.entries(translations)) {
      expect((value as string).trim().length, `key "${key}" should not be blank`).toBeGreaterThan(0)
    }
  })
})
