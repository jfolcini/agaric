/**
 * StatusPanel — shows materializer status info (p2-t15, p2-t16).
 *
 * Standalone panel with no props. Polls getStatus() every 5 seconds.
 * Displays 4 metrics: foreground queue depth, background queue depth,
 * total ops dispatched, total background dispatched.
 */

import { Activity } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { StatusInfo } from '../lib/tauri'
import { getStatus } from '../lib/tauri'

export function StatusPanel(): React.ReactElement {
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await getStatus()
      setStatus(resp)
    } catch {
      // Silently fail
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadStatus()
    const interval = setInterval(loadStatus, 5000)
    return () => clearInterval(interval)
  }, [loadStatus])

  return (
    <div className="status-panel space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="status-panel-title flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Materializer Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !status && (
            <div className="status-panel-loading grid grid-cols-2 gap-4">
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
            </div>
          )}

          {status && (
            <div className="status-panel-metrics grid grid-cols-2 gap-4">
              <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                <div className="status-metric-value text-2xl font-bold">
                  {status.foreground_queue_depth}
                </div>
                <div className="status-metric-label text-sm text-muted-foreground">
                  Foreground Queue
                </div>
              </div>
              <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                <div className="status-metric-value text-2xl font-bold">
                  {status.background_queue_depth}
                </div>
                <div className="status-metric-label text-sm text-muted-foreground">
                  Background Queue
                </div>
              </div>
              <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                <div className="status-metric-value text-2xl font-bold">
                  {status.total_ops_dispatched}
                </div>
                <div className="status-metric-label text-sm text-muted-foreground">
                  Ops Dispatched
                </div>
              </div>
              <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                <div className="status-metric-value text-2xl font-bold">
                  {status.total_background_dispatched}
                </div>
                <div className="status-metric-label text-sm text-muted-foreground">
                  Background Dispatched
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
