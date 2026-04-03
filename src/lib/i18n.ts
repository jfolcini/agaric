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

      // Errors
      'error.generic': 'Something went wrong',
      'error.loadFailed': 'Failed to load data',
      'error.saveFailed': 'Failed to save',
      'error.createBlockFailed': 'Failed to create block',
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
