/**
 * Every command the `/` menu can offer has a one-line description in every
 * locale the app ships, so the command reference never shows a bare key.
 * A locale that has not translated it yet shows English (`fallbackLng`).
 */

import { describe, expect, it } from 'vitest'

import { slashCommandDescriptionKey } from '@/components/editor/SlashCommandReferenceSheet'
import { i18n } from '@/lib/i18n'
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales'
import { loadLocale } from '@/lib/i18n/set-locale'
import { ALL_SLASH_COMMANDS } from '@/lib/slash-commands'

describe('slash command descriptions', () => {
  it.each(SUPPORTED_LOCALES)('every command has one in %s', async (locale) => {
    await loadLocale(locale)
    const translate = i18n.getFixedT(locale)
    const missing = ALL_SLASH_COMMANDS.map((command) =>
      slashCommandDescriptionKey(command.id),
    ).filter((key) => {
      const text = translate(key)
      return text === key || text.trim() === ''
    })
    expect(missing).toEqual([])
  })
})
