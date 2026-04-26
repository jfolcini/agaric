/**
 * useMcpActivityFeed — subscribes to the `mcp:activity` Tauri event bus
 * and exposes a bounded, newest-first list of MCP activity entries.
 *
 * Extracted from AgentAccessSettingsTab.tsx so the activity-feed
 * subscription, the rolling 100-entry render buffer, and the periodic
 * tick that refreshes relative-time labels live in one place.
 *
 * The hook attaches the listener on mount of the consuming component
 * (AgentAccessSettingsTab), so the feed begins receiving events even
 * before the initial status fetch resolves — matching the original
 * inline behaviour.
 */

import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'

/**
 * Mirrors the Rust `ActivityEntry` struct emitted on the `mcp:activity`
 * Tauri event bus (see `src-tauri/src/mcp/activity.rs`).
 *
 * `sessionId` is the per-connection ULID assigned by the MCP backend —
 * required for every entry so the feed can group/scope activity by
 * session in future slices.
 *
 * `opRef` is populated only for read-write tool successes that wrote an
 * op to the log.  RO tools, failed calls, and user-authored entries
 * leave it undefined.  The field stays `snake_case` inside the object
 * because it mirrors the Rust `OpRef` type exposed in
 * `src/lib/bindings.ts` — the backend serialises `device_id` / `seq`
 * that way and the wrapper in `tauri.ts` forwards the same shape.
 */
export interface ActivityEntry {
  toolName: string
  summary: string
  timestamp: string // ISO-8601
  actorKind: 'user' | 'agent'
  agentName?: string | undefined
  result: { kind: 'ok' } | { kind: 'err'; message: string }
  sessionId: string
  opRef?: { device_id: string; seq: number } | undefined
}

export const MCP_ACTIVITY_EVENT = 'mcp:activity'
export const ACTIVITY_RENDER_CAP = 100

export interface UseMcpActivityFeedResult {
  entries: ActivityEntry[]
}

export function useMcpActivityFeed(): UseMcpActivityFeedResult {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [, setTick] = useState<number>(0)

  // Re-render every 60 s so relative-time labels in the activity feed
  // refresh ("2m ago" → "3m ago") without needing a separate interval
  // per row.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // Subscribe to `mcp:activity` events — each completed tool call from
  // the backend fires one event carrying a single `ActivityEntry` payload.
  // Maintain a bounded render buffer (oldest entries drop off at 100).
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    listen<ActivityEntry>(MCP_ACTIVITY_EVENT, (event) => {
      if (cancelled) return
      setEntries((prev) => [event.payload, ...prev].slice(0, ACTIVITY_RENDER_CAP))
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((err) => {
        // Not in Tauri context (e.g. running under Vite dev server without
        // the tauri-mock shim) — log and keep the empty feed rendering.
        logger.warn('AgentAccessSettingsTab', 'failed to subscribe to mcp:activity', undefined, err)
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return { entries }
}
