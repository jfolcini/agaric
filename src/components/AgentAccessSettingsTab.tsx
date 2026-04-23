/**
 * AgentAccessSettingsTab — Settings tab for the FEAT-4 MCP (Model Context
 * Protocol) agent-access surface.
 *
 * Sections (top to bottom):
 *   1. Read-only access toggle (backed by the `mcp-ro-enabled` marker
 *      file; toggling fires `mcp_set_enabled`).
 *   2. RO socket path display + copy button.
 *   3. Copy-config buttons for Claude Desktop + generic MCP clients
 *      (RO socket — RW config snippets are out of scope for slice 2).
 *   4. Recent activity feed (rolling 100-entry subscription to the
 *      `mcp:activity` Tauri event).
 *   5. RO kill switch — disconnect every live RO agent connection
 *      (no-op if none are live; wrapped in an AlertDialog confirmation).
 *   6. Read-write access toggle (backed by the `mcp-rw-enabled` marker
 *      file; toggling fires `mcp_rw_set_enabled`). Displays a destructive
 *      warning badge while enabled.
 *   7. RW socket path display + copy button.
 *   8. RW kill switch — disconnect every live RW agent connection.
 *
 * The backend exposes the following Tauri commands consumed here:
 *   - `get_mcp_status` / `get_mcp_rw_status` → `{ enabled, socket_path,
 *     active_connections }`.
 *   - `mcp_set_enabled(enabled)` / `mcp_rw_set_enabled(enabled)` — toggle
 *     marker file + start/stop the serve task.
 *   - `mcp_disconnect_all` / `mcp_rw_disconnect_all` — wake every
 *     in-flight connection so its handler drops.
 *
 * Every IPC call has an error-path fallback per AGENTS.md §Testing
 * Conventions — the component logs via `logger.warn` / `logger.error`,
 * shows a toast, and keeps rendering (no crash on IPC rejection).
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Copy, Undo2 } from 'lucide-react'
import type React from 'react'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
import { revertOps } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from './ConfirmDialog'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'

/** Mirrors the Rust `McpStatus` struct exposed by `get_mcp_status`. */
interface McpStatus {
  enabled: boolean
  socket_path: string
  active_connections: number
}

/**
 * Mirrors the Rust `McpRwStatus` struct exposed by `get_mcp_rw_status`.
 * Same shape as `McpStatus` but a distinct type so the RO / RW
 * surfaces stay symmetric.
 */
interface McpRwStatus {
  enabled: boolean
  socket_path: string
  active_connections: number
}

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
interface ActivityEntry {
  toolName: string
  summary: string
  timestamp: string // ISO-8601
  actorKind: 'user' | 'agent'
  agentName?: string | undefined
  result: { kind: 'ok' } | { kind: 'err'; message: string }
  sessionId: string
  opRef?: { device_id: string; seq: number } | undefined
}

/**
 * Shape of an `AppError::NonReversible` once it crosses the Tauri IPC
 * boundary.  Used by the undo handler to branch on a dedicated toast —
 * the 6 current RW tools never produce non-reversible ops, but this
 * guard exists for forward-compat (future `purge_block` surfacing etc).
 */
function isNonReversibleError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    (err as { kind?: unknown }).kind === 'non_reversible'
  )
}

const MCP_ACTIVITY_EVENT = 'mcp:activity'
const ACTIVITY_RENDER_CAP = 100

/**
 * Which socket a pending disconnect-all confirmation applies to. `null`
 * means the confirm dialog is closed.
 */
type ConfirmTarget = 'ro' | 'rw' | null

export function AgentAccessSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [rwStatus, setRwStatus] = useState<McpRwStatus | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null)
  const [, setTick] = useState<number>(0)
  // Per-entry loading state for the Undo button on agent-authored RW
  // activity rows, keyed by `${device_id}:${seq}`.  Buttons disable +
  // swap to a spinner while their key is in the set.
  const [undoingKeys, setUndoingKeys] = useState<Set<string>>(() => new Set())
  // FEAT-4h slice 4 — per-session bulk revert.
  //
  // Confirmation target for the per-session bulk-revert flow.  The
  // payload carries the session id + the exact opRefs we'll submit so
  // confirm-time count matches the confirmed action.  Null when the
  // dialog is closed.
  const [pendingSessionRevert, setPendingSessionRevert] = useState<{
    sessionId: string
    ops: Array<{ device_id: string; seq: number }>
  } | null>(null)
  // Session ids currently in-flight — used to disable the per-session
  // button and swap its icon to a spinner.  Keyed by sessionId.
  const [revertingSessions, setRevertingSessions] = useState<Set<string>>(() => new Set())

  // Re-render every 60 s so relative-time labels in the activity feed
  // refresh ("2m ago" → "3m ago") without needing a separate interval
  // per row.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const loadStatus = useCallback(async () => {
    // Fetch RO and RW status in parallel. Use `allSettled` so a failure
    // on one side does not prevent the other section from rendering —
    // the RW backend could be absent (older Rust binary) while RO is
    // healthy, or vice versa during a staged rollout.
    const [roResult, rwResult] = await Promise.allSettled([
      invoke<McpStatus>('get_mcp_status'),
      invoke<McpRwStatus>('get_mcp_rw_status'),
    ])

    if (roResult.status === 'fulfilled') {
      setStatus(roResult.value)
      setError(null)
    } else {
      logger.error(
        'AgentAccessSettingsTab',
        'failed to load MCP status',
        undefined,
        roResult.reason,
      )
      setError(t('agentAccess.loadFailed'))
    }

    if (rwResult.status === 'fulfilled') {
      setRwStatus(rwResult.value)
    } else {
      logger.error(
        'AgentAccessSettingsTab',
        'failed to load MCP RW status',
        undefined,
        rwResult.reason,
      )
    }

    setLoading(false)
  }, [t])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

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

  const handleToggleRo = useCallback(
    async (nextEnabled: boolean) => {
      // Optimistic update so the Switch reflects the intent immediately;
      // roll back on IPC rejection.
      const previous = status
      setStatus((s) => (s === null ? s : { ...s, enabled: nextEnabled }))
      try {
        await invoke('mcp_set_enabled', { enabled: nextEnabled })
        toast.success(
          nextEnabled ? t('agentAccess.toggleOnSuccess') : t('agentAccess.toggleOffSuccess'),
        )
        // Re-fetch status so `active_connections` reflects the backend
        // side of the toggle (disabling fires disconnect_all).
        void loadStatus()
      } catch (err) {
        logger.error(
          'AgentAccessSettingsTab',
          'failed to set MCP enabled',
          { enabled: nextEnabled },
          err,
        )
        setStatus(previous)
        toast.error(t('agentAccess.toggleFailed'))
      }
    },
    [status, loadStatus, t],
  )

  const handleToggleRw = useCallback(
    async (nextEnabled: boolean) => {
      const previous = rwStatus
      setRwStatus((s) => (s === null ? s : { ...s, enabled: nextEnabled }))
      try {
        await invoke('mcp_rw_set_enabled', { enabled: nextEnabled })
        toast.success(
          nextEnabled ? t('agentAccess.rwToggleOnSuccess') : t('agentAccess.rwToggleOffSuccess'),
        )
        void loadStatus()
      } catch (err) {
        logger.error(
          'AgentAccessSettingsTab',
          'failed to set MCP RW enabled',
          { enabled: nextEnabled },
          err,
        )
        setRwStatus(previous)
        toast.error(t('agentAccess.toggleFailed'))
      }
    },
    [rwStatus, loadStatus, t],
  )

  const handleDisconnectAll = useCallback(async () => {
    setConfirmTarget(null)
    try {
      await invoke('mcp_disconnect_all')
      toast.success(t('agentAccess.disconnectSuccess'))
      void loadStatus()
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to disconnect all', undefined, err)
      toast.error(t('agentAccess.disconnectFailed'))
    }
  }, [loadStatus, t])

  const handleDisconnectAllRw = useCallback(async () => {
    setConfirmTarget(null)
    try {
      await invoke('mcp_rw_disconnect_all')
      toast.success(t('agentAccess.rwDisconnectSuccess'))
      void loadStatus()
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to disconnect all RW', undefined, err)
      toast.error(t('agentAccess.rwDisconnectFailed'))
    }
  }, [loadStatus, t])

  // Revert a single agent-authored op from the activity feed.  Called
  // from the per-entry Undo button — only rendered on agent + ok +
  // opRef-present rows.  Tracks in-flight state via `undoingKeys` so
  // the button disables and swaps to a spinner while the IPC call is
  // pending.  On `NonReversible` we show a dedicated toast; every
  // other error falls through to the generic failure toast.
  const handleUndo = useCallback(
    async (opRef: { device_id: string; seq: number }) => {
      const key = `${opRef.device_id}:${opRef.seq}`
      setUndoingKeys((prev) => {
        const next = new Set(prev)
        next.add(key)
        return next
      })
      try {
        await revertOps({ ops: [opRef] })
        toast.success(t('agentAccess.undoAgentOp.success'))
      } catch (err) {
        logger.error('AgentAccessSettingsTab', 'undo failed', { opRef }, err)
        toast.error(
          isNonReversibleError(err)
            ? t('agentAccess.undoAgentOp.nonReversible')
            : t('agentAccess.undoAgentOp.failed'),
        )
      } finally {
        setUndoingKeys((prev) => {
          if (!prev.has(key)) return prev
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [t],
  )

  // FEAT-4h slice 4 — derived per-session data.
  //
  // Walk the current entries (newest-first) and bucket the opRef of
  // every agent+ok+opRef entry by sessionId.  Used to:
  //   - gate the per-session "Revert session" button on ≥ 2 ops
  //   - collect the opRef payload when the button is clicked
  //   - decide which entry gets the session header (the first-seen
  //     of each sessionId in newest-first order)
  const undoableBySession = useMemo(() => {
    const map = new Map<string, Array<{ device_id: string; seq: number }>>()
    for (const entry of entries) {
      if (entry.actorKind === 'agent' && entry.result.kind === 'ok' && entry.opRef != null) {
        const list = map.get(entry.sessionId) ?? []
        list.push(entry.opRef)
        map.set(entry.sessionId, list)
      }
    }
    return map
  }, [entries])

  // First-seen indices by sessionId, computed in newest-first order.
  // The header lands on the most-recent entry of a session so it sits
  // at the top of the group as the user scrolls the feed.
  const firstSeenIdxBySession = useMemo(() => {
    const m = new Map<string, number>()
    entries.forEach((entry, idx) => {
      if (!m.has(entry.sessionId)) m.set(entry.sessionId, idx)
    })
    return m
  }, [entries])

  // User clicked "Revert session" on a session header — open the
  // confirm dialog with the exact opRefs we'll submit.  The ops array
  // is a snapshot of the session's undoable entries at click time; if
  // the ring rolls over between the click and the confirmation, the
  // user still reverts what they saw.
  const handleRevertSessionClick = useCallback(
    (sessionId: string) => {
      const ops = undoableBySession.get(sessionId) ?? []
      if (ops.length === 0) return
      setPendingSessionRevert({ sessionId, ops })
    },
    [undoableBySession],
  )

  // Confirmed — fire revertOps with the full set.  Mirrors
  // handleUndo's error handling (generic failure vs NonReversible).
  const confirmRevertSession = useCallback(async () => {
    const target = pendingSessionRevert
    if (target === null) return
    setPendingSessionRevert(null)
    setRevertingSessions((prev) => {
      const next = new Set(prev)
      next.add(target.sessionId)
      return next
    })
    try {
      await revertOps({ ops: target.ops })
      toast.success(t('agentAccess.revertSession.success', { count: target.ops.length }))
    } catch (err) {
      logger.error(
        'AgentAccessSettingsTab',
        'revert session failed',
        { sessionId: target.sessionId, opCount: target.ops.length },
        err,
      )
      toast.error(
        isNonReversibleError(err)
          ? t('agentAccess.revertSession.nonReversible')
          : t('agentAccess.revertSession.failed'),
      )
    } finally {
      setRevertingSessions((prev) => {
        if (!prev.has(target.sessionId)) return prev
        const next = new Set(prev)
        next.delete(target.sessionId)
        return next
      })
    }
  }, [pendingSessionRevert, t])

  const socketPath = status?.socket_path ?? ''
  const rwSocketPath = rwStatus?.socket_path ?? ''

  // The Claude Desktop config snippet. Docs-only per the FEAT-4 decision
  // — we copy the JSON to the clipboard and let the user paste it into
  // `claude_desktop_config.json` themselves.
  const claudeConfigJson = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            agaric: {
              command: 'agaric-mcp',
              env: { AGARIC_MCP_SOCKET: socketPath },
            },
          },
        },
        null,
        2,
      ),
    [socketPath],
  )

  // Generic MCP client config — flat shape without the `mcpServers`
  // wrapper so clients that embed the server definition directly can
  // use it.
  const genericConfigJson = useMemo(
    () =>
      JSON.stringify(
        {
          command: 'agaric-mcp',
          env: { AGARIC_MCP_SOCKET: socketPath },
        },
        null,
        2,
      ),
    [socketPath],
  )

  const copyToClipboard = useCallback(
    async (text: string, successKey: string) => {
      try {
        await navigator.clipboard.writeText(text)
        toast.success(t(successKey))
      } catch (err) {
        logger.warn('AgentAccessSettingsTab', 'clipboard write failed', undefined, err)
        toast.error(t('agentAccess.copyFailed'))
      }
    },
    [t],
  )

  if (loading) {
    return (
      <div className="space-y-4 max-w-xl">
        <LoadingSkeleton count={4} height="h-10" />
      </div>
    )
  }

  const effectiveStatus: McpStatus = status ?? {
    enabled: false,
    socket_path: '',
    active_connections: 0,
  }

  const effectiveRwStatus: McpRwStatus = rwStatus ?? {
    enabled: false,
    socket_path: '',
    active_connections: 0,
  }

  return (
    <div className="agent-access-tab space-y-6 max-w-xl">
      <div>
        <h2 className="text-base font-medium">{t('agentAccess.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('agentAccess.description')}</p>
      </div>

      {error !== null && (
        <p className="text-sm text-destructive" role="status">
          {error}
        </p>
      )}

      {/* Read-only access toggle */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="mcp-ro-toggle" muted={false}>
            {t('agentAccess.roToggleLabel')}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            {t('agentAccess.roToggleDescription')}
          </p>
        </div>
        <Switch
          id="mcp-ro-toggle"
          checked={effectiveStatus.enabled}
          onCheckedChange={handleToggleRo}
          aria-label={t('agentAccess.roToggleLabel')}
          disabled={status === null}
        />
      </div>

      {/* Socket path */}
      <div className="space-y-2">
        <Label htmlFor="mcp-socket-path" muted={false}>
          {t('agentAccess.socketPathLabel')}
        </Label>
        <div className="flex items-center gap-2">
          <code
            id="mcp-socket-path"
            className="flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono break-all"
            data-testid="mcp-socket-path"
          >
            {socketPath || '\u00A0'}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => void copyToClipboard(socketPath, 'agentAccess.socketPathCopied')}
            aria-label={t('agentAccess.copySocketPathLabel')}
            disabled={!socketPath}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Copy-config buttons */}
      <div className="space-y-2">
        <Label muted={false}>{t('agentAccess.configLabel')}</Label>
        <p className="text-xs text-muted-foreground">{t('agentAccess.configDescription')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyToClipboard(claudeConfigJson, 'agentAccess.claudeConfigCopied')}
          >
            {t('agentAccess.copyClaudeConfigButton')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void copyToClipboard(genericConfigJson, 'agentAccess.genericConfigCopied')
            }
          >
            {t('agentAccess.copyGenericConfigButton')}
          </Button>
        </div>
      </div>

      {/* Activity feed */}
      <div className="space-y-2">
        <Label muted={false}>{t('agentAccess.activityLabel')}</Label>
        {entries.length === 0 ? (
          <EmptyState message={t('agentAccess.activityEmpty')} compact />
        ) : (
          <ScrollArea className="h-[280px] rounded-md border" data-testid="mcp-activity-feed">
            {/*
             * `role="log"` lives on a wrapper `<div>` rather than the
             * `<ul>` so axe-core's `aria-allowed-role` + `listitem`
             * rules are satisfied: the live-region semantics stay
             * intact while the `<ul>` keeps its implicit `list` role
             * (required so `<li>` children are properly contained).
             */}
            <TooltipProvider>
              <div role="log" aria-live="polite" aria-label={t('agentAccess.activityLabel')}>
                <ul className="divide-y">
                  {entries.map((entry, idx) => {
                    // Show the Undo button iff the entry is an agent-authored
                    // successful RW tool call (opRef is backend-populated only
                    // in that exact case).  RO tools, failures, and user-authored
                    // rows render nothing in that slot — no disabled button.
                    const canUndo =
                      entry.actorKind === 'agent' &&
                      entry.result.kind === 'ok' &&
                      entry.opRef != null
                    const undoKey =
                      entry.opRef != null ? `${entry.opRef.device_id}:${entry.opRef.seq}` : null
                    const isUndoing = undoKey !== null && undoingKeys.has(undoKey)
                    // FEAT-4h slice 4 — session-header controls.  The
                    // header renders on the first-seen entry of each
                    // session (in newest-first order, i.e. the most
                    // recent row of that session) and only when the
                    // session has ≥ 2 undoable ops.  One-action sessions
                    // fall through to the per-entry Undo button.
                    const sessionOps = undoableBySession.get(entry.sessionId) ?? []
                    const isFirstSeenOfSession = firstSeenIdxBySession.get(entry.sessionId) === idx
                    const showSessionHeader = isFirstSeenOfSession && sessionOps.length >= 2
                    const isRevertingSession = revertingSessions.has(entry.sessionId)
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: append-only ring, idx stable per-entry
                      <Fragment key={`${entry.timestamp}-${idx}-${entry.toolName}`}>
                        {showSessionHeader && (
                          <li
                            className="flex items-center justify-between gap-3 px-3 py-2 bg-muted/30 text-xs text-muted-foreground border-b"
                            data-testid="mcp-activity-session-header"
                            data-session-id={entry.sessionId}
                          >
                            <span className="font-medium">
                              {t('agentAccess.revertSession.buttonAriaLabel', {
                                count: sessionOps.length,
                              })}
                            </span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="shrink-0"
                                  onClick={() => handleRevertSessionClick(entry.sessionId)}
                                  disabled={isRevertingSession}
                                  aria-busy={isRevertingSession}
                                  aria-label={t('agentAccess.revertSession.buttonAriaLabel', {
                                    count: sessionOps.length,
                                  })}
                                  data-testid="mcp-activity-revert-session"
                                >
                                  {isRevertingSession ? (
                                    <Spinner size="sm" />
                                  ) : (
                                    <>
                                      <Undo2 className="h-3.5 w-3.5 mr-1" />
                                      <span>{t('agentAccess.revertSession.button')}</span>
                                    </>
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('agentAccess.revertSession.buttonAriaLabel', {
                                  count: sessionOps.length,
                                })}
                              </TooltipContent>
                            </Tooltip>
                          </li>
                        )}
                        <li
                          className="activity-row flex items-start gap-3 p-3 text-sm"
                          data-testid="mcp-activity-row"
                        >
                          <Badge variant="outline" className="font-mono text-xs shrink-0">
                            {entry.toolName}
                          </Badge>
                          <span
                            className={cn(
                              'flex-1 break-words',
                              entry.result.kind === 'err' && 'text-destructive',
                            )}
                          >
                            {entry.summary}
                          </span>
                          <time
                            className="text-xs text-muted-foreground shrink-0 tabular-nums"
                            dateTime={entry.timestamp}
                          >
                            {formatRelativeTime(entry.timestamp, t)}
                          </time>
                          {canUndo && entry.opRef != null && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="shrink-0"
                                  onClick={() => {
                                    if (entry.opRef != null) void handleUndo(entry.opRef)
                                  }}
                                  disabled={isUndoing}
                                  aria-busy={isUndoing}
                                  aria-label={t('agentAccess.undoAgentOp.ariaLabel')}
                                  data-testid="mcp-activity-undo"
                                >
                                  {isUndoing ? (
                                    <Spinner size="sm" />
                                  ) : (
                                    <Undo2 className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('agentAccess.undoAgentOp.tooltip')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </li>
                      </Fragment>
                    )
                  })}
                </ul>
              </div>
            </TooltipProvider>
          </ScrollArea>
        )}
      </div>

      {/* RO kill switch */}
      <div className="space-y-2">
        <Label muted={false}>{t('agentAccess.killSwitchLabel')}</Label>
        <p className="text-xs text-muted-foreground">
          {effectiveStatus.active_connections === 0
            ? t('agentAccess.killSwitchDescriptionNone')
            : t('agentAccess.killSwitchDescription', {
                count: effectiveStatus.active_connections,
              })}
        </p>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmTarget('ro')}
          disabled={effectiveStatus.active_connections === 0}
          aria-label={t('agentAccess.killSwitchButton')}
        >
          {t('agentAccess.killSwitchButton')}
        </Button>
      </div>

      {/* Read-write access toggle */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Label htmlFor="mcp-rw-toggle" muted={false}>
              {t('agentAccess.rwToggleLabel')}
            </Label>
            {effectiveRwStatus.enabled && (
              <Badge variant="destructive" data-testid="mcp-rw-warning-badge">
                {t('agentAccess.rwEnabledWarning')}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {t('agentAccess.rwToggleDescription')}
          </p>
        </div>
        <Switch
          id="mcp-rw-toggle"
          checked={effectiveRwStatus.enabled}
          onCheckedChange={handleToggleRw}
          aria-label={t('agentAccess.rwToggleLabel')}
          disabled={rwStatus === null}
        />
      </div>

      {/* RW socket path */}
      <div className="space-y-2">
        <Label htmlFor="mcp-rw-socket-path" muted={false}>
          {t('agentAccess.rwSocketPathLabel')}
        </Label>
        <div className="flex items-center gap-2">
          <code
            id="mcp-rw-socket-path"
            className="flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono break-all"
            data-testid="mcp-rw-socket-path"
          >
            {rwSocketPath || '\u00A0'}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => void copyToClipboard(rwSocketPath, 'agentAccess.rwSocketPathCopied')}
            aria-label={t('agentAccess.copyRwSocketPathLabel')}
            disabled={!rwSocketPath}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* RW kill switch */}
      <div className="space-y-2">
        <Label muted={false}>{t('agentAccess.rwKillSwitchLabel')}</Label>
        <p className="text-xs text-muted-foreground">
          {effectiveRwStatus.active_connections === 0
            ? t('agentAccess.rwKillSwitchDescriptionNone')
            : t('agentAccess.rwKillSwitchDescription', {
                count: effectiveRwStatus.active_connections,
              })}
        </p>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmTarget('rw')}
          disabled={effectiveRwStatus.active_connections === 0}
          aria-label={t('agentAccess.rwKillSwitchButton')}
        >
          {t('agentAccess.rwKillSwitchButton')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmTarget === 'ro'}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null)
        }}
        title={t('agentAccess.confirmDisconnectTitle')}
        description={t('agentAccess.confirmDisconnectDescription')}
        actionLabel={t('agentAccess.confirmDisconnectAction')}
        actionVariant="destructive"
        onAction={() => void handleDisconnectAll()}
      />

      <ConfirmDialog
        open={confirmTarget === 'rw'}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null)
        }}
        title={t('agentAccess.rwConfirmDisconnectTitle')}
        description={t('agentAccess.rwConfirmDisconnectDescription')}
        actionLabel={t('agentAccess.rwConfirmDisconnectAction')}
        actionVariant="destructive"
        onAction={() => void handleDisconnectAllRw()}
      />

      {/* FEAT-4h slice 4 — per-session bulk revert confirmation */}
      <ConfirmDialog
        open={pendingSessionRevert !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSessionRevert(null)
        }}
        title={t('agentAccess.revertSession.confirmTitle')}
        description={t('agentAccess.revertSession.confirmDescription', {
          count: pendingSessionRevert?.ops.length ?? 0,
        })}
        actionLabel={t('agentAccess.revertSession.confirmAction')}
        actionVariant="destructive"
        onAction={() => void confirmRevertSession()}
      />
    </div>
  )
}
