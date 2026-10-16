/**
 * PageBrowserCreateRow — `Create page "query"`, offered above the Pages
 * results while the search text names no page (#5637). It opens the New page
 * dialog pre-filled, where the similar-name check runs over the whole space;
 * this row only sees the loaded rows and the alias the view resolved.
 */

import { Plus } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { BlockRow } from '@/lib/bindings'
import { openNewPageDialog } from '@/lib/overlay-events'

interface PageBrowserCreateRowProps {
  query: string
  pages: readonly Pick<BlockRow, 'content'>[]
  /** The page whose alias is exactly the query, if any (`usePageBrowserFilters`). */
  aliasMatchId: string | null
}

export function PageBrowserCreateRow({
  query,
  pages,
  aliasMatchId,
}: PageBrowserCreateRowProps): React.ReactElement | null {
  const { t } = useTranslation()
  const name = query.trim()
  if (name === '' || aliasMatchId != null) return null
  const lowerName = name.toLowerCase()
  if (pages.some((page) => (page.content ?? '').toLowerCase() === lowerName)) return null
  return (
    <Button
      variant="outline"
      className="w-full justify-start"
      data-testid="page-browser-create-row"
      onClick={() => openNewPageDialog(name)}
    >
      <Plus />
      <span className="truncate">{t('pageBrowser.createPageNamed', { name })}</span>
    </Button>
  )
}
