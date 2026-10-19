/**
 * HistoryNavButtons — the header's Back / Forward, shown on every view from
 * `md` up. A phone has none: Android's system back walks the same history
 * (`back-handlers.ts`), and the row's width goes to the journal stepper.
 *
 * Steps through `@/stores/navigation-history`: journal periods, pages and
 * views in the order they were visited, per space. Arrows rather than
 * chevrons so they never read as the journal's previous / next day.
 */

import { ArrowLeft, ArrowRight } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { selectNavHistory, useNavigationStore } from '@/stores/navigation'
import { canStep, navigateBack, navigateForward } from '@/stores/navigation-history'
import { useResolveStore } from '@/stores/resolve'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

export function HistoryNavButtons(): React.ReactElement {
  const { t } = useTranslation()
  const spaceKey = useSpaceStore((s) => s.currentSpaceId ?? LEGACY_SPACE_KEY)
  const history = useNavigationStore((s) => selectNavHistory(s, spaceKey))
  // Deleted pages are stepped over, so deleting one can leave an arrow with nowhere to go.
  useResolveStore((s) => s.version)

  return (
    <div className="flex shrink-0 items-center gap-0.5 max-md:hidden">
      <IconButton
        variant="ghost"
        size="icon-xs"
        ariaLabel={t('nav.back')}
        tooltip={t('nav.back')}
        disabled={!canStep(history, -1)}
        onClick={navigateBack}
      >
        <ArrowLeft className="h-4 w-4" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-xs"
        ariaLabel={t('nav.forward')}
        tooltip={t('nav.forward')}
        disabled={!canStep(history, 1)}
        onClick={navigateForward}
      >
        <ArrowRight className="h-4 w-4" />
      </IconButton>
    </div>
  )
}
