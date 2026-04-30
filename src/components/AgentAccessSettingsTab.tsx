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
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { useMcpActivityFeed } from '@/hooks/useMcpActivityFeed'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { ActivityFeed } from './agent-access/ActivityFeed'
import type { McpRwStatus, McpStatus } from './agent-access/McpStatusSection'
import { McpStatusSection } from './agent-access/McpStatusSection'
import { LoadingSkeleton } from './LoadingSkeleton'

export function AgentAccessSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [rwStatus, setRwStatus] = useState<McpRwStatus | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const { entries } = useMcpActivityFeed()

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

  // MAINT-120: RO toggle. Optimistic flip; revert via the captured
  // `previous` snapshot if the IPC rejects. On success we refetch so
  // `active_connections` reflects the backend (disabling fires
  // disconnect_all).
  const { execute: executeToggleRo } = useIpcCommand<
    { enabled: boolean; previous: McpStatus | null },
    void
  >({
    call: ({ enabled }) => invoke('mcp_set_enabled', { enabled }),
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
      toast.success(enabled ? t('agentAccess.toggleOnSuccess') : t('agentAccess.toggleOffSuccess'))
      void loadStatus()
    },
    onError: () => {
      toast.error(t('agentAccess.toggleFailed'))
    },
  })

  const handleToggleRo = useCallback(
    async (nextEnabled: boolean) => {
      await executeToggleRo({ enabled: nextEnabled, previous: status })
    },
    [executeToggleRo, status],
  )

  // MAINT-120: RW toggle. Same shape as RO but flips the RW status.
  const { execute: executeToggleRw } = useIpcCommand<
    { enabled: boolean; previous: McpRwStatus | null },
    void
  >({
    call: ({ enabled }) => invoke('mcp_rw_set_enabled', { enabled }),
    module: 'AgentAccessSettingsTab',
    errorLogMessage: 'failed to set MCP RW enabled',
    errorLogContext: ({ enabled }) => ({ enabled }),
    optimistic: ({ enabled }) => {
      setRwStatus((s) => (s === null ? s : { ...s, enabled }))
    },
    revert: ({ previous }) => {
      setRwStatus(previous)
    },
    onSuccess: (_result, { enabled }) => {
      toast.success(
        enabled ? t('agentAccess.rwToggleOnSuccess') : t('agentAccess.rwToggleOffSuccess'),
      )
      void loadStatus()
    },
    onError: () => {
      toast.error(t('agentAccess.toggleFailed'))
    },
  })

  const handleToggleRw = useCallback(
    async (nextEnabled: boolean) => {
      await executeToggleRw({ enabled: nextEnabled, previous: rwStatus })
    },
    [executeToggleRw, rwStatus],
  )

  // MAINT-120: RO kill switch — disconnect every active RO agent session.
  const { execute: executeDisconnectAll } = useIpcCommand<void, void>({
    call: () => invoke('mcp_disconnect_all'),
    module: 'AgentAccessSettingsTab',
    errorLogMessage: 'failed to disconnect all',
    onSuccess: () => {
      toast.success(t('agentAccess.disconnectSuccess'))
      void loadStatus()
    },
    onError: () => {
      toast.error(t('agentAccess.disconnectFailed'))
    },
  })

  const handleDisconnectAll = useCallback(async () => {
    await executeDisconnectAll()
  }, [executeDisconnectAll])

  // MAINT-120: RW kill switch — disconnect every active RW agent session.
  const { execute: executeDisconnectAllRw } = useIpcCommand<void, void>({
    call: () => invoke('mcp_rw_disconnect_all'),
    module: 'AgentAccessSettingsTab',
    errorLogMessage: 'failed to disconnect all RW',
    onSuccess: () => {
      toast.success(t('agentAccess.rwDisconnectSuccess'))
      void loadStatus()
    },
    onError: () => {
      toast.error(t('agentAccess.rwDisconnectFailed'))
    },
  })

  const handleDisconnectAllRw = useCallback(async () => {
    await executeDisconnectAllRw()
  }, [executeDisconnectAllRw])

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
        await writeText(text)
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

      {/* Read-only access section (toggle + socket path + activity + kill switch) */}
      <McpStatusSection
        variant="ro"
        status={status}
        onToggle={(next) => void handleToggleRo(next)}
        onCopySocket={(path) => void copyToClipboard(path, 'agentAccess.socketPathCopied')}
        onDisconnect={() => void handleDisconnectAll()}
      >
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
        <ActivityFeed entries={entries} />
      </McpStatusSection>

      {/* Read-write access section (toggle + socket path + kill switch) */}
      <McpStatusSection
        variant="rw"
        status={rwStatus}
        onToggle={(next) => void handleToggleRw(next)}
        onCopySocket={(path) => void copyToClipboard(path, 'agentAccess.rwSocketPathCopied')}
        onDisconnect={() => void handleDisconnectAllRw()}
      />
    </div>
  )
}
