/**
 * AgentAccessSettingsTab — Settings tab for the FEAT-4 MCP (Model Context
 * Protocol) agent-access surface.
 *
 * Sections (top to bottom):
 *   1. Read-only access toggle (backed by the `mcp-ro-enabled` marker
 *      file; toggling fires `mcp_set_enabled`).
 *   2. Socket path display + copy button.
 *   3. Copy-config buttons for Claude Desktop + generic MCP clients.
 *   4. Recent activity feed (rolling 100-entry subscription to the
 *      `mcp:activity` Tauri event).
 *   5. Kill switch — disconnect every live agent connection (no-op if
 *      none are live; wrapped in an AlertDialog confirmation).
 *   6. Read-write access toggle (placeholder — disabled, "Coming in v2").
 *
 * The backend exposes three Tauri commands consumed here:
 *   - `get_mcp_status` → `{ enabled, socket_path, active_connections }`
 *   - `mcp_set_enabled(enabled)` → toggles marker file + starts/stops
 *     the serve task.
 *   - `mcp_disconnect_all` → wakes every in-flight connection so their
 *     handler drops.
 *
 * Every IPC call has an error-path fallback per AGENTS.md §Testing
 * Conventions — the component logs via `logger.warn` / `logger.error`,
 * shows a toast, and keeps rendering (no crash on IPC rejection).
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Copy } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
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
 * Mirrors the Rust `ActivityEntry` struct emitted on the `mcp:activity`
 * Tauri event bus (see `src-tauri/src/mcp/activity.rs`).
 */
interface ActivityEntry {
  toolName: string
  summary: string
  timestamp: string // ISO-8601
  actorKind: 'user' | 'agent'
  agentName?: string | undefined
  result: { kind: 'ok' } | { kind: 'err'; message: string }
}

const MCP_ACTIVITY_EVENT = 'mcp:activity'
const ACTIVITY_RENDER_CAP = 100

export function AgentAccessSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false)
  const [, setTick] = useState<number>(0)

  // Re-render every 60 s so relative-time labels in the activity feed
  // refresh ("2m ago" → "3m ago") without needing a separate interval
  // per row.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const result = await invoke<McpStatus>('get_mcp_status')
      setStatus(result)
      setError(null)
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to load MCP status', undefined, err)
      setError(t('agentAccess.loadFailed'))
    } finally {
      setLoading(false)
    }
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
        logger.warn(
          'AgentAccessSettingsTab',
          'failed to subscribe to mcp:activity',
          undefined,
          err,
        )
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

  const handleDisconnectAll = useCallback(async () => {
    setConfirmOpen(false)
    try {
      await invoke('mcp_disconnect_all')
      toast.success(t('agentAccess.disconnectSuccess'))
      void loadStatus()
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to disconnect all', undefined, err)
      toast.error(t('agentAccess.disconnectFailed'))
    }
  }, [loadStatus, t])

  const socketPath = status?.socket_path ?? ''

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
            size="sm"
            className="shrink-0 h-8 w-8 p-0"
            onClick={() =>
              void copyToClipboard(socketPath, 'agentAccess.socketPathCopied')
            }
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
            onClick={() =>
              void copyToClipboard(claudeConfigJson, 'agentAccess.claudeConfigCopied')
            }
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
            <ul className="divide-y">
              {entries.map((entry, idx) => (
                <li
                  // Activity entries are append-only; a composite key of
                  // (timestamp, index, toolName) is stable across renders
                  // because `entries` is only prepended to.
                  key={`${entry.timestamp}-${idx}-${entry.toolName}`}
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
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>

      {/* Kill switch */}
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
          onClick={() => setConfirmOpen(true)}
          disabled={effectiveStatus.active_connections === 0}
          aria-label={t('agentAccess.killSwitchButton')}
        >
          {t('agentAccess.killSwitchButton')}
        </Button>
      </div>

      {/* Read-write access toggle (placeholder for v2) */}
      <div className="flex items-start justify-between gap-4 opacity-60">
        <div className="flex-1">
          <Label htmlFor="mcp-rw-toggle" muted={false}>
            {t('agentAccess.rwToggleLabel')}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            {t('agentAccess.rwToggleDescription')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary">{t('agentAccess.comingInV2')}</Badge>
          <Switch
            id="mcp-rw-toggle"
            checked={false}
            disabled
            aria-label={t('agentAccess.rwToggleLabel')}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('agentAccess.confirmDisconnectTitle')}
        description={t('agentAccess.confirmDisconnectDescription')}
        actionLabel={t('agentAccess.confirmDisconnectAction')}
        actionVariant="destructive"
        onAction={() => void handleDisconnectAll()}
      />
    </div>
  )
}
