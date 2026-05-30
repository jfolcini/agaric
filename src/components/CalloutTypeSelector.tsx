/**
 * CalloutTypeSelector — popover content for choosing a callout variant (#215).
 *
 * The toolbar Callout button previously inserted only the `info` variant; the
 * other four (warning / tip / error / note) were slash-only. This popover
 * surfaces all five (icon + label), mirroring the code-block language selector.
 * Selecting a variant dispatches `INSERT_CALLOUT` with the chosen `type` in the
 * event detail — `useBlockTreeEventListeners` applies it to the focused block.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { dispatchBlockEvent } from '@/lib/block-events'

import { CALLOUT_CONFIG } from './RichContentRenderer/context'
import { Button } from './ui/button'

const CALLOUT_TYPES = ['info', 'warning', 'tip', 'error', 'note'] as const

export interface CalloutTypeSelectorProps {
  onClose: () => void
}

export function CalloutTypeSelector({ onClose }: CalloutTypeSelectorProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-0.5" role="menu" aria-label={t('toolbar.callout')}>
      {CALLOUT_TYPES.map((type) => {
        const Icon = CALLOUT_CONFIG[type]?.icon
        return (
          <Button
            key={type}
            variant="ghost"
            size="sm"
            role="menuitem"
            className="justify-start text-sm gap-2"
            data-testid={`callout-type-${type}`}
            onPointerDown={(e) => {
              e.preventDefault()
              dispatchBlockEvent('INSERT_CALLOUT', { type })
              onClose()
            }}
          >
            {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
            {t(`callout.${type}`)}
          </Button>
        )
      })}
    </div>
  )
}
