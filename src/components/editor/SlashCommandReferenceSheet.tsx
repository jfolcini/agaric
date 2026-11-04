/**
 * Every command the page editor's `/` menu offers, grouped by the menu's own
 * categories: built from the registry, so a new command is listed by itself.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { type ReferenceEntry, ReferenceSheet } from '@/components/editor/ReferenceSheet'
import { KbdChord } from '@/components/ui/kbd'
import { pageSlashCommandCatalog } from '@/editor/page-mode/page-slash-commands'
import type { PickerItem } from '@/editor/SuggestionList'
import { getShortcutKeys } from '@/lib/keyboard-config/storage'

/** The i18n key of command `id`'s one-line description: `repeat-.+daily` → `…repeatFromDoneDaily`. */
export function slashCommandDescriptionKey(id: string): string {
  const segment = id
    .replace('.+', 'from-done-')
    .replace('++', 'catch-up-')
    .replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  return `slashCommand.description.${segment}`
}

/** What the menu shows a command as: its label up to the dash. */
function commandName(command: PickerItem): string {
  return command.label.split(' — ')[0] ?? command.label
}

function shortcutOf(command: PickerItem): string {
  return command.shortcutId !== undefined
    ? getShortcutKeys(command.shortcutId)
    : (command.keys ?? '')
}

interface SlashCommandReferenceSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SlashCommandReferenceSheet({
  open,
  onOpenChange,
}: SlashCommandReferenceSheetProps): React.ReactElement {
  const { t } = useTranslation()
  const sections = new Map<string, { id: string; heading: string; entries: ReferenceEntry[] }>()
  for (const command of pageSlashCommandCatalog()) {
    const category = command.category ?? ''
    let section = sections.get(category)
    if (section === undefined) {
      section = { id: category, heading: t(category), entries: [] }
      sections.set(category, section)
    }
    const keys = shortcutOf(command)
    section.entries.push({
      id: command.id,
      name: commandName(command),
      description: t(slashCommandDescriptionKey(command.id)),
      ...(keys !== '' && { aside: <KbdChord keys={keys} className="shrink-0" /> }),
    })
  }
  return (
    <ReferenceSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('referenceSheet.commands.title')}
      description={t('referenceSheet.commands.description')}
      filterLabel={t('referenceSheet.commands.filter')}
      sections={[...sections.values()]}
    />
  )
}
