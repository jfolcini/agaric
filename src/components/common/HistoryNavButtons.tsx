/**
 * HistoryNavButtons — the header's Back / Forward, shown on every view except
 * a touch phone. A phone has none: Android's system back walks the same history
 * (`back-handlers.ts`), and the row's width goes to the journal stepper. A narrow
 * desktop window keeps them: it has no system back. Hidden, not
 * unmounted, so the e2e specs can still drive the phone's `goBack` through it.
 *
 * Steps through `@/stores/navigation-history`: journal periods, pages and
 * views in the order they were visited, per space. Arrows rather than
 * chevrons so they never read as the journal's previous / next day.
 */

import { ArrowLeft, ArrowRight } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { Kbd } from '@/components/ui/kbd'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'
import { getShortcutKeys, toAriaKeyshortcuts } from '@/lib/keyboard-config'
import { selectNavHistory, useNavigationStore } from '@/stores/navigation'
import { canStep, navigateBack, navigateForward } from '@/stores/navigation-history'
import { useResolveStore } from '@/stores/resolve'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

export function HistoryNavButtons(): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const isMobile = useIsMobile()
  const spaceKey = useSpaceStore((s) => s.currentSpaceId ?? LEGACY_SPACE_KEY)
  const history = useNavigationStore((s) => selectNavHistory(s, spaceKey))
  // Deleted pages are stepped over, so deleting one can leave an arrow with nowhere to go.
  useResolveStore((s) => s.version)
  const backKeys = getShortcutKeys('navigateBack')
  const forwardKeys = getShortcutKeys('navigateForward')

  return (
    <div className="flex shrink-0 items-center gap-0.5" hidden={isTouch && isMobile}>
      <IconButton
        variant="ghost"
        size="icon-xs"
        ariaLabel={t('nav.back')}
        aria-keyshortcuts={toAriaKeyshortcuts(backKeys)}
        tooltip={
          <>
            {t('nav.back')}{' '}
            <Kbd className="ml-1" aria-hidden="true">
              {backKeys}
            </Kbd>
          </>
        }
        disabled={!canStep(history, -1)}
        onClick={navigateBack}
      >
        <ArrowLeft className="h-4 w-4" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-xs"
        ariaLabel={t('nav.forward')}
        aria-keyshortcuts={toAriaKeyshortcuts(forwardKeys)}
        tooltip={
          <>
            {t('nav.forward')}{' '}
            <Kbd className="ml-1" aria-hidden="true">
              {forwardKeys}
            </Kbd>
          </>
        }
        disabled={!canStep(history, 1)}
        onClick={navigateForward}
      >
        <ArrowRight className="h-4 w-4" />
      </IconButton>
    </div>
  )
}
