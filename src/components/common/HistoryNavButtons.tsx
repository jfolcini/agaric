/**
 * HistoryNavButtons — the header's Back / Forward, shown on every view.
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
import { navigateBack, navigateForward } from '@/stores/navigation-history'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

export function HistoryNavButtons(): React.ReactElement {
  const { t } = useTranslation()
  const spaceKey = useSpaceStore((s) => s.currentSpaceId ?? LEGACY_SPACE_KEY)
  const { entries, index } = useNavigationStore((s) => selectNavHistory(s, spaceKey))

  return (
    // `self-start` pins them beside the hamburger when a phone header wraps.
    <div className="flex shrink-0 items-center gap-0.5 self-start sm:self-center">
      {/* 24px wide below md, like the journal row's other icons, which is
          what lets the phone journal header keep a readable date. */}
      <IconButton
        variant="ghost"
        size="icon-xs"
        className="max-md:w-6!"
        ariaLabel={t('nav.back')}
        tooltip={t('nav.back')}
        disabled={index <= 0}
        onClick={navigateBack}
      >
        <ArrowLeft className="h-4 w-4" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-xs"
        className="max-md:w-6!"
        ariaLabel={t('nav.forward')}
        tooltip={t('nav.forward')}
        disabled={index >= entries.length - 1}
        onClick={navigateForward}
      >
        <ArrowRight className="h-4 w-4" />
      </IconButton>
    </div>
  )
}
