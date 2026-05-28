/**
 * SearchSheetTrigger — magnifying-glass button in the App header that
 * opens the unified mobile search sheet with a context-aware default
 * segment (in-page when the user is reading a page; all-pages
 * elsewhere).
 *
 * Mobile-only. The render-time `isMobile` check is at the App level
 * (`{isMobile && <SearchSheetTrigger />}` in `App.tsx`) so this
 * component doesn't subscribe to navigation / sheet state on desktop
 * sessions where it never mounts.
 */

import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import { useNavigationStore } from '../stores/navigation'
import { defaultModeForView, useSearchSheetStore } from '../stores/useSearchSheetStore'

export function SearchSheetTrigger(): React.ReactElement {
  const { t } = useTranslation()
  const currentView = useNavigationStore((s) => s.currentView)

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={t('searchSheet.openButton')}
      data-testid="search-sheet-trigger"
      onClick={() => {
        useSearchSheetStore.getState().open$(defaultModeForView(currentView))
      }}
    >
      <Search className="h-5 w-5" aria-hidden />
    </Button>
  )
}
