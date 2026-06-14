/**
 * DependencyIndicator — shows a subtle Link2 icon with tooltip when a block
 * has a `blocked_by` property (value_ref type). Used in AgendaResults metadata.
 *
 * Props:
 *   blockId — the block whose properties to check
 *   propertiesCache — optional shared ref-based cache (legacy fallback path)
 *
 * The component reads properties from a parent-mounted
 * `BatchPropertiesProvider` (PEND-35 Tier 2.4a) when present, collapsing
 * what was previously N per-row `getProperties` IPCs on initial mount
 * into a single batched query at the `AgendaResults` parent.
 *
 * When NO provider is mounted (e.g. a one-off render outside an agenda
 * list), the component falls back to the legacy per-block
 * `getProperties` path, optionally backed by the provided
 * `propertiesCache` ref to dedupe re-renders.
 */

import { Link2 } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBatchProperties } from '@/hooks/useBatchProperties'
import { logger } from '@/lib/logger'
import type { PropertyRow } from '@/lib/tauri'
import { batchResolve, getProperties } from '@/lib/tauri'
import { cn } from '@/lib/utils'

export interface DependencyIndicatorProps {
  /** Block ID to check for blocked_by property */
  blockId: string
  /**
   * Optional shared cache for the legacy fallback path. When a
   * `BatchPropertiesProvider` is mounted at the parent, this cache is
   * unused — properties come from the provider directly.
   */
  propertiesCache?: React.RefObject<Map<string, PropertyRow[]>> | undefined
  /** Additional CSS classes */
  className?: string | undefined
}

export function DependencyIndicator({
  blockId,
  propertiesCache,
  className,
}: DependencyIndicatorProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [blockedByTitle, setBlockedByTitle] = useState<string | null>(null)
  const [hasBlockedBy, setHasBlockedBy] = useState(false)

  const batchProperties = useBatchProperties()
  // Read from the provider (if mounted) — `undefined` means "not in
  // cache yet" (initial fetch still pending or block missing from
  // batch). Empty array means "fetched, no properties".
  const providerProps = batchProperties?.get(blockId)

  useEffect(() => {
    let cancelled = false

    async function loadDependency() {
      try {
        let props: PropertyRow[] | undefined

        if (batchProperties) {
          // Provider path — wait for the batch to populate. If the
          // provider has resolved (`loading === false`) and the block
          // is absent from its map, the block has no properties.
          if (providerProps !== undefined) {
            props = providerProps
          } else if (!batchProperties.loading) {
            // Batch resolved but this block is absent → no props.
            props = []
          } else {
            // Batch still pending; bail and let the next render (when
            // `providerProps` updates) re-trigger this effect.
            return
          }
        } else {
          // Legacy fallback — check the optional ref cache, else fetch.
          const cached = propertiesCache?.current.get(blockId)
          if (cached) {
            props = cached
          } else {
            props = await getProperties(blockId)
            propertiesCache?.current.set(blockId, props)
          }
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
        } catch (err) {
          // Best-effort title resolution — fall back to the generic tooltip text.
          logger.warn(
            'DependencyIndicator',
            'Failed to resolve blocking task',
            { blockId, blockedByRef: blockedByProp.value_ref },
            err,
          )
        }
      } catch (err) {
        // Best-effort property fetch — if it fails we just don't show the indicator.
        logger.warn(
          'DependencyIndicator',
          'Failed to fetch properties for dependency indicator',
          { blockId },
          err,
        )
      }
    }

    loadDependency()
    return () => {
      cancelled = true
    }
  }, [blockId, propertiesCache, batchProperties, providerProps])

  if (!hasBlockedBy) return null

  const tooltipText = blockedByTitle
    ? t('dependency.blockedBy', { title: blockedByTitle })
    : t('dependency.blockedByUnresolved')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('inline-flex items-center text-muted-foreground', className)}
          data-testid="dependency-indicator"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- labelled wrapper around an inline SVG icon and the Tooltip's asChild trigger ref; <img> is a void element that can't contain the SVG child
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
  )
}
