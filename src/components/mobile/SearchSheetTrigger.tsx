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
import { getPinnedSearchScope } from '@/lib/pinned-search-scope'
import { useNavigationStore } from '@/stores/navigation'
import { defaultModeForView, useSearchSheetStore } from '@/stores/useSearchSheetStore'

export function SearchSheetTrigger(): React.ReactElement | null {
  const { t } = useTranslation()
  const currentView = useNavigationStore((s) => s.currentView)
  // The Search view is the search; a second way into it only crowds its header.
  if (currentView === 'search') return null

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      // The icon, not the button, on the header's 16px content edge, like the
      // hamburger's at the other end.
      className="-mr-1 [@media(pointer:coarse)]:-mr-3.5"
      aria-label={t('searchSheet.openButton')}
      data-testid="search-sheet-trigger"
      onClick={() => {
        // #135 — a pinned scope overrides the context-aware default.
        // The user explicitly chose a preferred scope via long-press;
        // honour it regardless of the current view.
        const pinned = getPinnedSearchScope()
        useSearchSheetStore.getState().open$(pinned ?? defaultModeForView(currentView))
      }}
    >
      <Search aria-hidden />
    </Button>
  )
}
