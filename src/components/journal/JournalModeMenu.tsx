/**
 * JournalModeMenu — the journal's mode switcher as one menu button, used
 * below `lg` in place of the five mode tabs (see `JournalControls`).
 *
 * The trigger names the current mode: its initial on a phone, the word from
 * `sm` up. The accessible name always carries the full mode.
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
          variant="secondary"
          size="xs"
          className={cn('shrink-0 gap-0.5 max-sm:px-1.5!', className)}
          aria-label={t('journal.viewModeMenuLabel', { mode: current })}
        >
          <span className="sm:hidden" aria-hidden="true">
            {current.charAt(0)}
          </span>
          <span className="max-sm:hidden" aria-hidden="true">
            {current}
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <MenuPopoverContent align="start" className="w-40 p-1">
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
