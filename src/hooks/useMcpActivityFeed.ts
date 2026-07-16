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
 *
 * #2506 — mount-time backfill. `get_mcp_recent_activity` reads back the
 * shared `McpActivityRing` (#695) so a late subscriber sees tool calls
 * that fired before this hook's `mcp:activity` listener registered — the
 * common case, since the Agent Access settings tab mounts rarely and
 * briefly. Backfill entries are merged with whatever the live listener
 * already accumulated, deduped by `sessionId` + `timestamp` (mirrors the
 * `recovery:degraded` / `useDeepLinkRouter` "emit + query-on-mount
 * backfill" shape).
 */

import { useEffect, useState } from 'react'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { unwrap } from '@/lib/tauri'

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

/**
 * Normalize a wire `ActivityEntry_Serialize` (from `get_mcp_recent_activity`)
 * into this hook's `ActivityEntry` shape — the two are structurally the
 * same except the generated binding's optional fields carry `null` where
 * this hook (matching the live-event payload) uses `undefined`.
 */
function fromRingEntry(entry: {
  toolName: string
  summary: string
  timestamp: string
  actorKind: 'user' | 'agent'
  agentName?: string | null
  result: { kind: 'ok' } | { kind: 'err'; message: string }
  sessionId: string
  opRef?: { device_id: string; seq: number } | null
}): ActivityEntry {
  return {
    toolName: entry.toolName,
    summary: entry.summary,
    timestamp: entry.timestamp,
    actorKind: entry.actorKind,
    agentName: entry.agentName ?? undefined,
    result: entry.result,
    sessionId: entry.sessionId,
    opRef: entry.opRef ?? undefined,
  }
}

/**
 * Merge backfilled ring entries into the current feed, deduping by
 * `sessionId` + `timestamp` (the wire payload carries no separate entry
 * id) so an entry the live listener already appended before the backfill
 * resolved is not doubled. Re-sorts the union newest-first and re-applies
 * the render cap.
 */
export function mergeActivityBackfill(
  live: ActivityEntry[],
  backfill: ActivityEntry[],
): ActivityEntry[] {
  const seen = new Set(live.map((e) => `${e.sessionId}:${e.timestamp}`))
  const merged = [...live]
  for (const entry of backfill) {
    const key = `${entry.sessionId}:${entry.timestamp}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  return merged.slice(0, ACTIVITY_RENDER_CAP)
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
  //
  // The listen/unlisten lifecycle (incl. the unmount-before-resolve race)
  // lives in `useTauriEventListener`; the functional `setEntries` updater
  // needs no ref refresh, so the shared hook's handler ref handles it.
  useTauriEventListener<ActivityEntry>(
    MCP_ACTIVITY_EVENT,
    (event) => {
      setEntries((prev) => [event.payload, ...prev].slice(0, ACTIVITY_RENDER_CAP))
    },
    {
      onError: (err) => {
        // Not in Tauri context (e.g. running under Vite dev server without
        // the tauri-mock shim) — log and keep the empty feed rendering.
        logger.warn('AgentAccessSettingsTab', 'failed to subscribe to mcp:activity', undefined, err)
      },
    },
  )

  // #2506 — mount-time backfill. Runs once: seeds the feed from the
  // shared ring so pre-mount tool calls show up even though the settings
  // tab (and therefore this hook) mounts well after they fired. Merged
  // with whatever the live listener above accumulated in the meantime.
  useEffect(() => {
    let cancelled = false
    commands
      .getMcpRecentActivity()
      .then((result) => {
        if (cancelled) return
        const backfill = unwrap(result)
        if (backfill == null || backfill.length === 0) return
        setEntries((prev) => mergeActivityBackfill(prev, backfill.map(fromRingEntry)))
      })
      .catch((err: unknown) => {
        // Not in Tauri context, or the IPC rejected — log and keep
        // whatever the live listener has accumulated so far.
        logger.warn(
          'AgentAccessSettingsTab',
          'getMcpRecentActivity() backfill rejected',
          undefined,
          err,
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { entries }
}
