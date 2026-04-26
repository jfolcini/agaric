/**
 * ActivityFeed — rolling list of MCP `mcp:activity` events.
 *
 * Renders one `<li>` per `ActivityEntry` (newest-first), with:
 *   - the tool-name badge, summary, and relative timestamp;
 *   - a per-entry Undo button on agent-authored RW successes
 *     (FEAT-4h slice 3);
 *   - a session-header row above the first-seen entry of any session
 *     with ≥ 2 undoable ops (FEAT-4h slice 4 — bulk revert).
 *
 * Extracted from AgentAccessSettingsTab.tsx so the feed-renderer
 * concern (per-entry undo state, per-session bulk-revert state, the
 * UX-252 terminal-state tracking, the `revert_ops` IPC plumbing, and
 * the bulk-revert confirm dialog) lives in one place.  The parent
 * passes the `entries` array (sourced from `useMcpActivityFeed`) and
 * keeps owning device-info / toggle state.
 */

import { Undo2 } from 'lucide-react'
import type React from 'react'
import { Fragment, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ActivityEntry } from '@/hooks/useMcpActivityFeed'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
import { revertOps } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { SessionRevertControls } from './SessionRevertControls'

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

export interface ActivityFeedProps {
  entries: ActivityEntry[]
}

export function ActivityFeed({ entries }: ActivityFeedProps): React.ReactElement {
  const { t } = useTranslation()
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
  // UX-252 — terminal-state tracking. Once an opRef has been successfully
  // reverted (single-entry Undo OR per-session bulk revert), its button
  // disappears from the feed so the user can't click again and hit
  // unexpected backend double-undo behaviour. Scoped to the component
  // lifetime — ephemeral, matches the activity-feed's own 100-entry render
  // ring.
  const [revertedOpKeys, setRevertedOpKeys] = useState<Set<string>>(() => new Set())

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
        // UX-252 — mark this opRef's button as terminal-success so it
        // disappears from the feed. On error the key is NOT added, so
        // the user can retry.
        setRevertedOpKeys((prev) => {
          const next = new Set(prev)
          next.add(key)
          return next
        })
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
      if (
        entry.actorKind === 'agent' &&
        entry.result.kind === 'ok' &&
        entry.opRef != null &&
        // UX-252 — opRefs that have been successfully reverted drop out
        // of the per-session list so the header's visible count + the
        // ≥ 2 visibility gate both reflect the remaining undoable ops.
        !revertedOpKeys.has(`${entry.opRef.device_id}:${entry.opRef.seq}`)
      ) {
        const list = map.get(entry.sessionId) ?? []
        list.push(entry.opRef)
        map.set(entry.sessionId, list)
      }
    }
    return map
  }, [entries, revertedOpKeys])

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
      // UX-252 — mark every opRef in the batch as terminal-success so
      // the session header + every per-entry Undo button in this
      // session drop out of the feed. On error none are added, so
      // the user can retry the whole batch.
      setRevertedOpKeys((prev) => {
        const next = new Set(prev)
        for (const op of target.ops) {
          next.add(`${op.device_id}:${op.seq}`)
        }
        return next
      })
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

  return (
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
                    entry.opRef != null &&
                    // UX-252 — a successful revert marks this opRef as
                    // terminal-success; the button disappears from
                    // the feed so the user can't double-click through
                    // an unexpected backend toggle (delete↔restore,
                    // etc).
                    !revertedOpKeys.has(`${entry.opRef.device_id}:${entry.opRef.seq}`)
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
                        <SessionRevertControls
                          sessionId={entry.sessionId}
                          opCount={sessionOps.length}
                          isReverting={isRevertingSession}
                          onClick={() => handleRevertSessionClick(entry.sessionId)}
                        />
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
                                  <>
                                    <Undo2 className="h-3.5 w-3.5" />
                                    {/*
                                     * UX-253 — hidden by default (icon-only on
                                     * desktop), revealed on coarse pointers so
                                     * touch-only users get a visible label
                                     * alongside the icon. The `aria-label` +
                                     * tooltip stay unchanged to avoid
                                     * double-labelling screen readers.
                                     */}
                                    <span className="hidden [@media(pointer:coarse)]:inline ml-1">
                                      {t('agentAccess.undoAgentOp.buttonText')}
                                    </span>
                                  </>
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('agentAccess.undoAgentOp.tooltip')}</TooltipContent>
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
