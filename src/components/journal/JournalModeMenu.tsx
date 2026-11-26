/**
 * JournalModeMenu — the journal's mode switcher as one menu button, used
 * below `lg` in place of the five mode tabs (see `JournalControls`).
 *
 * The trigger names the current mode in a word; its accessible name carries
 * the menu's purpose too.
 */

import { Check, ChevronDown } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { cn } from '@/lib/utils'

interface JournalModeMenuProps<M extends string> {
  modes: readonly M[]
  mode: M
  labels: Record<M, string>
  onSelect: (mode: M) => void
  className?: string | undefined
}

export function JournalModeMenu<M extends string>({
  modes,
  mode,
  labels,
  onSelect,
  className,
}: JournalModeMenuProps<M>): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const current = labels[mode]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn(
            'shrink-0 gap-0.5 max-sm:px-1.5! [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11',
            className,
          )}
          aria-label={t('journal.viewModeMenuLabel', { mode: current })}
        >
          <span aria-hidden="true">{current}</span>
          {/* A 360 px phone's row has room for the word but not the chevron too. */}
          <ChevronDown className="max-[380px]:hidden" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <MenuPopoverContent align="start" className="w-40">
        <ul
          className="m-0 flex list-none flex-col gap-0.5 p-0"
          aria-label={t('journal.viewModeLabel')}
        >
          {modes.map((m) => (
            <li key={m}>
              <PopoverMenuItem
                className="flex items-center justify-between"
                active={m === mode}
                aria-current={m === mode ? 'true' : undefined}
                onClick={() => {
                  onSelect(m)
                  setOpen(false)
                }}
              >
                {labels[m]}
                {m === mode && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
              </PopoverMenuItem>
            </li>
          ))}
        </ul>
      </MenuPopoverContent>
    </Popover>
  )
}
