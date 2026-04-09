/**
 * DependencyIndicator — shows a subtle Link2 icon with tooltip when a block
 * has a `blocked_by` property (value_ref type). Used in AgendaResults metadata.
 *
 * Props:
 *   blockId — the block whose properties to check
 *   propertiesCache — shared ref-based cache to avoid redundant fetches
 *
 * The component lazy-loads properties on mount and caches results in the
 * provided Map ref so sibling agenda items don't re-fetch.
 */

import { Link2 } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PropertyRow } from '../lib/tauri'
import { batchResolve, getProperties } from '../lib/tauri'

export interface DependencyIndicatorProps {
  /** Block ID to check for blocked_by property */
  blockId: string
  /** Shared cache so multiple indicators don't re-fetch the same block */
  propertiesCache: React.MutableRefObject<Map<string, PropertyRow[]>>
  /** Additional CSS classes */
  className?: string
}

export function DependencyIndicator({
  blockId,
  propertiesCache,
  className,
}: DependencyIndicatorProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [blockedByTitle, setBlockedByTitle] = useState<string | null>(null)
  const [hasBlockedBy, setHasBlockedBy] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadDependency() {
      try {
        // Check cache first
        let props = propertiesCache.current.get(blockId)
        if (!props) {
          props = await getProperties(blockId)
          propertiesCache.current.set(blockId, props)
        }

        const blockedByProp = props.find((p) => p.key === 'blocked_by' && p.value_ref != null)

        if (cancelled) return

        if (!blockedByProp?.value_ref) {
          setHasBlockedBy(false)
          return
        }

        setHasBlockedBy(true)

        // Try to resolve the title of the blocking task
        try {
          const resolved = await batchResolve([blockedByProp.value_ref])
          if (!cancelled && resolved.length > 0 && resolved[0]?.title) {
            setBlockedByTitle(resolved[0].title)
          }
        } catch {
          // Silently ignore — we'll show the fallback tooltip text
        }
      } catch {
        // Silently ignore — property fetch failed, just don't show indicator
      }
    }

    loadDependency()
    return () => {
      cancelled = true
    }
  }, [blockId, propertiesCache])

  if (!hasBlockedBy) return null

  const tooltipText = blockedByTitle
    ? t('dependency.blockedBy', { title: blockedByTitle })
    : t('dependency.blockedByUnresolved')

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn('inline-flex items-center text-muted-foreground', className)}
            data-testid="dependency-indicator"
            role="img"
            aria-label={tooltipText}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
