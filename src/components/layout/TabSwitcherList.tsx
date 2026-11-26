/**
 * The body of the TabBar's tab switcher: every open tab under a filter input.
 * The filter is a case-insensitive substring over the shown label and the full
 * path; the list is in memory, so there is no debounce. cmdk supplies the
 * combobox: ArrowUp / ArrowDown move through the matches, Enter activates.
 * Its own module so cmdk stays off the boot path (#5441).
 */

import { Check, X } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { TruncatedText } from '@/components/ui/truncated-text'
import { getPageDisplayName } from '@/lib/page-display'
import type { Tab } from '@/stores/tabs'

export interface TabSwitcherListProps {
  tabs: Tab[]
  activeTabIndex: number
  displayLabel: (fullPath: string) => string
  onActivate: (index: number) => void
  onClose: (index: number) => void
}

export function TabSwitcherList({
  tabs,
  activeTabIndex,
  displayLabel,
  onActivate,
  onClose,
}: TabSwitcherListProps): React.ReactElement {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const rows = tabs.flatMap((tab, index) => {
    const fullPath = tab.label || t('tabs.untitled')
    const title = displayLabel(fullPath)
    const matches = title.toLowerCase().includes(needle) || fullPath.toLowerCase().includes(needle)
    // A tab shows only its leaf, so the switcher names the parents too.
    const parentPath = getPageDisplayName(fullPath, 'leaf-with-breadcrumb').breadcrumb
    return matches ? [{ tab, index, title, parentPath }] : []
  })

  return (
    // Opens on the active tab, as the strip's menu did; typing moves to the first match.
    <Command
      shouldFilter={false}
      loop
      label={t('tabs.switcher')}
      defaultValue={tabs[activeTabIndex]?.id ?? ''}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('tabs.switcherFilter')}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the switcher was just opened to type into; this module loads after Radix's open focus has already run
        autoFocus
      />
      <CommandList>
        <CommandEmpty>{t('tabs.switcherNoMatch')}</CommandEmpty>
        {rows.map(({ tab, index, title, parentPath }) => (
          <CommandItem
            key={tab.id}
            value={tab.id}
            className="gap-2"
            onSelect={() => onActivate(index)}
          >
            <span className="inline-flex size-4 shrink-0 items-center justify-center">
              {index === activeTabIndex ? (
                <>
                  <Check className="size-3" aria-hidden="true" />
                  <span className="sr-only">{t('tabs.activeTab')}</span>
                </>
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <TruncatedText>{title}</TruncatedText>
              {parentPath !== undefined && (
                <TruncatedText className="text-xs text-muted-foreground">
                  {parentPath}
                </TruncatedText>
              )}
            </span>
            {/* Mouse close, as on the strip: a widget inside an option is a
                nested-interactive violation. The menu stays open so several
                tabs can be pruned in a row; at one tab the bar unmounts. */}
            <span
              data-tab-switcher-close=""
              aria-hidden="true"
              className="inline-flex shrink-0 items-center justify-center rounded-sm p-1 hover:bg-destructive/20 coarse:min-h-(--touch-target) coarse:min-w-(--touch-target)"
              onClick={(e) => {
                e.stopPropagation()
                onClose(index)
              }}
            >
              <X className="size-3" />
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
