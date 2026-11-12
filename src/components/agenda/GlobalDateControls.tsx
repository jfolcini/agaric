/**
 * GlobalDateControls — the App header's Today button on every view but the
 * journal itself (which renders `JournalControls`). Today's page is where most
 * writing happens, so every view carries the same one button (#6548); the
 * journal's own header has Agenda and the calendar.
 *
 * It does not show on a touch phone: the drawer's Journal entry is one tap
 * away, and the row is for the view's own title. A narrow mouse window keeps it.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore } from '@/stores/navigation'

export function GlobalDateControls(): React.ReactElement | null {
  const { t } = useTranslation()
  const navigateToDate = useJournalStore((s) => s.navigateToDate)
  const setView = useNavigationStore((s) => s.setView)
  const isTouch = useIsTouch()
  const isMobile = useIsMobile()

  if (isTouch && isMobile) return null

  function handleToday() {
    setView('journal')
    navigateToDate(new Date(), 'daily')
  }

  return (
    <Button variant="outline" size="xs" onClick={handleToday} aria-label={t('journal.goToToday')}>
      {t('journal.today')}
    </Button>
  )
}
