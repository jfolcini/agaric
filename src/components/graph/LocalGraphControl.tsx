/**
 * LocalGraphControl — "focus on this page" toggle + hop-depth selector (#1429).
 *
 * Additive control surfaced in the GraphView header. When the active tab has a
 * page open, a toggle enters **local-graph mode**: the graph is filtered to the
 * N-hop neighborhood of that page (computed client-side from the already-fetched
 * link graph — see `@/lib/graph-neighborhood`). A segmented hop control (1 / 2)
 * lets the user widen the neighborhood. The global graph is unaffected when the
 * toggle is off (this view defaults to off).
 */

import { Focus, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { LOCAL_GRAPH_HOP_OPTIONS, type LocalGraphHops } from '@/lib/graph-neighborhood'

export interface LocalGraphControlProps {
  /** Whether local-graph mode is currently active. */
  active: boolean
  /** Toggle local-graph mode on/off. */
  onToggle: (active: boolean) => void
  /** Current hop depth. */
  hops: LocalGraphHops
  /** Change the hop depth. */
  onHopsChange: (hops: LocalGraphHops) => void
  /**
   * Label of the page that would be (or is being) focused. `null` when no page
   * is open in the active tab — the toggle is then disabled with a hint.
   */
  seedLabel: string | null
}

export function LocalGraphControl({
  active,
  onToggle,
  hops,
  onHopsChange,
  seedLabel,
}: LocalGraphControlProps): React.ReactElement {
  const { t } = useTranslation()
  const hasSeed = seedLabel !== null

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background/80 p-2 backdrop-blur-sm"
      data-testid="local-graph-control"
    >
      <Button
        variant={active ? 'secondary' : 'outline'}
        size="xs"
        className="h-7 gap-1 text-xs"
        onClick={() => onToggle(!active)}
        disabled={!hasSeed}
        aria-pressed={active}
        title={hasSeed ? undefined : t('graph.local.noPage')}
        data-testid="local-graph-toggle"
      >
        {active ? (
          <X className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Focus className="h-3 w-3" aria-hidden="true" />
        )}
        {active ? t('graph.local.exit') : t('graph.local.focus')}
      </Button>

      {active && hasSeed && (
        <>
          <span
            className="text-xs text-muted-foreground"
            data-testid="local-graph-seed-label"
            aria-live="polite"
          >
            {t('graph.local.active', { page: seedLabel })}
          </span>
          <ToggleGroup
            type="single"
            value={String(hops)}
            onValueChange={(value: string) => {
              if (!value) return
              onHopsChange(Number(value) as LocalGraphHops)
            }}
            aria-label={t('graph.local.depthGroupLabel')}
            className="ml-1 h-7"
            data-testid="local-graph-hops"
          >
            {LOCAL_GRAPH_HOP_OPTIONS.map((option) => (
              <ToggleGroupItem
                key={option}
                value={String(option)}
                aria-label={t('graph.local.depthOption', { count: option })}
              >
                {option}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </>
      )}
    </div>
  )
}
