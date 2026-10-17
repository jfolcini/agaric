/**
 * AgentAccessTab — Settings tab for the MCP (Model Context Protocol)
 * agent-access surface. (The `'AgentAccessSettingsTab'` logger label below
 * is the stable telemetry namespace shared with the agent-access child
 * components.)
 *
 * Sections (top to bottom):
 *   1. The switch for the one MCP socket (backed by the `mcp-enabled`
 *      marker file; toggling fires `mcp_set_enabled`), and while it is on,
 *      the socket path and the connections with Disconnect all.
 *   2. Agents (#5667): each client's token, mode and spaces, with its config
 *      snippets. Always shown, since agents are set up before access is on.
 *   3. Recent activity feed (rolling 100-entry subscription to the
 *      `mcp:activity` Tauri event), always shown: its Undo buttons revert
 *      past agent writes, which still matters after access is turned off.
 *
 * Every IPC call has an error-path fallback per AGENTS.md §Testing
 * Conventions — the component logs via `logger.warn` / `logger.error`,
 * shows a toast, and keeps rendering (no crash on IPC rejection).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ActivityFeed } from '@/components/agent-access/ActivityFeed'
import { AgentList } from '@/components/agent-access/AgentList'
import { McpStatusSection } from '@/components/agent-access/McpStatusSection'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Card, CardContent } from '@/components/ui/card'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { useMcpActivityFeed } from '@/hooks/useMcpActivityFeed'
import { unwrap } from '@/lib/app-error'
import { commands, type McpStatus } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

export function AgentAccessTab(): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const { entries } = useMcpActivityFeed()

  const loadStatus = useCallback(async () => {
    try {
      setStatus(unwrap(await commands.getMcpStatus()))
      setError(null)
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to load MCP status', undefined, err)
      setError(t('agentAccess.loadFailed'))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- kicks off the MCP status IPC load; `loadStatus` awaits the command and sets loading/error state from its result; see #4407
    void loadStatus()
  }, [loadStatus])

  // Optimistic flip; revert via the captured `previous` snapshot if the IPC
  // rejects. On success we refetch so `active_connections` reflects the
  // backend (disabling fires disconnect_all).
  const { execute: executeToggle } = useIpcCommand<
    { enabled: boolean; previous: McpStatus | null },
    void
  >({
    call: async ({ enabled }) => {
      unwrap(await commands.mcpSetEnabled(enabled))
    },
    module: 'AgentAccessSettingsTab',
    errorLogMessage: 'failed to set MCP enabled',
    errorLogContext: ({ enabled }) => ({ enabled }),
    optimistic: ({ enabled }) => {
      setStatus((s) => (s === null ? s : { ...s, enabled }))
    },
    revert: ({ previous }) => {
      setStatus(previous)
    },
    onSuccess: (_result, { enabled }) => {
      notify.success(enabled ? t('agentAccess.toggleOnSuccess') : t('agentAccess.toggleOffSuccess'))
      void loadStatus()
    },
    onError: () => {
      notify.error(t('agentAccess.toggleFailed'))
    },
  })

  const handleToggle = useCallback(
    async (nextEnabled: boolean) => {
      await executeToggle({ enabled: nextEnabled, previous: status })
    },
    [executeToggle, status],
  )

  const { execute: executeDisconnectAll } = useIpcCommand<void, void>({
    call: async () => {
      unwrap(await commands.mcpDisconnectAll())
    },
    module: 'AgentAccessSettingsTab',
    errorLogMessage: 'failed to disconnect all',
    onSuccess: () => {
      notify.success(t('agentAccess.disconnectSuccess'))
      void loadStatus()
    },
    onError: () => {
      notify.error(t('agentAccess.disconnectFailed'))
    },
  })

  const handleDisconnectAll = useCallback(async () => {
    await executeDisconnectAll()
  }, [executeDisconnectAll])

  const copySocketPath = useCallback(
    async (path: string) => {
      try {
        await writeText(path)
        notify.success(t('agentAccess.socketPathCopied'))
      } catch (err) {
        logger.warn('AgentAccessSettingsTab', 'clipboard write failed', undefined, err)
        notify.error(t('agentAccess.copyFailed'))
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

  return (
    <div className="agent-access-tab space-y-6">
      <Card>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">{t('agentAccess.description')}</p>

          {error !== null && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <McpStatusSection
            status={status}
            onToggle={(next) => void handleToggle(next)}
            onCopySocket={(path) => void copySocketPath(path)}
            onDisconnect={() => void handleDisconnectAll()}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <AgentList socketPath={status?.socket_path ?? ''} />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <ActivityFeed entries={entries} />
        </CardContent>
      </Card>
    </div>
  )
}
