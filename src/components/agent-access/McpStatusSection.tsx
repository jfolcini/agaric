/**
 * McpStatusSection — toggle + status indicator for one MCP channel
 * (read-only or read-write).
 *
 * Wraps the original RO / RW sections (toggle row, socket-path display
 * with copy button, and kill-switch row + confirm dialog) in a single
 * variant-aware component.  AgentAccessSettingsTab.tsx instantiates it
 * twice — once for RO (with copy-config + activity feed slotted in via
 * `children` between the socket path and the kill switch) and once for
 * RW (no children — the RW section has no copy-config or feed).
 *
 * The kill-switch confirm-dialog state lives inside this component
 * because each variant has its own destructive flow with its own copy.
 * Toggling and disconnect IPC calls are owned by the parent — this
 * component just calls back into `onToggle` / `onDisconnect` so the
 * parent's logger label (`'AgentAccessSettingsTab'`) stays the source
 * of truth on the error paths.
 */

import { Copy } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '../ConfirmDialog'

/** Mirrors the Rust `McpStatus` struct exposed by `get_mcp_status`. */
export interface McpStatus {
  enabled: boolean
  socket_path: string
  active_connections: number
}

/**
 * Mirrors the Rust `McpRwStatus` struct exposed by `get_mcp_rw_status`.
 * Same shape as `McpStatus` but a distinct type so the RO / RW
 * surfaces stay symmetric.
 */
export interface McpRwStatus {
  enabled: boolean
  socket_path: string
  active_connections: number
}

export interface McpStatusSectionProps {
  variant: 'ro' | 'rw'
  status: McpStatus | McpRwStatus | null
  onToggle: (next: boolean) => void
  onCopySocket: (path: string) => void
  onDisconnect: () => void
  children?: React.ReactNode
}

export function McpStatusSection({
  variant,
  status,
  onToggle,
  onCopySocket,
  onDisconnect,
  children,
}: McpStatusSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false)

  const isRw = variant === 'rw'
  const effectiveStatus = status ?? {
    enabled: false,
    socket_path: '',
    active_connections: 0,
  }
  const socketPath = effectiveStatus.socket_path

  const toggleId = isRw ? 'mcp-rw-toggle' : 'mcp-ro-toggle'
  const toggleLabelKey = isRw ? 'agentAccess.rwToggleLabel' : 'agentAccess.roToggleLabel'
  const toggleDescriptionKey = isRw
    ? 'agentAccess.rwToggleDescription'
    : 'agentAccess.roToggleDescription'

  const socketPathId = isRw ? 'mcp-rw-socket-path' : 'mcp-socket-path'
  const socketPathLabelKey = isRw ? 'agentAccess.rwSocketPathLabel' : 'agentAccess.socketPathLabel'
  const socketPathTestId = isRw ? 'mcp-rw-socket-path' : 'mcp-socket-path'
  const copySocketLabelKey = isRw
    ? 'agentAccess.copyRwSocketPathLabel'
    : 'agentAccess.copySocketPathLabel'

  const killSwitchLabelKey = isRw ? 'agentAccess.rwKillSwitchLabel' : 'agentAccess.killSwitchLabel'
  const killSwitchDescriptionNoneKey = isRw
    ? 'agentAccess.rwKillSwitchDescriptionNone'
    : 'agentAccess.killSwitchDescriptionNone'
  const killSwitchDescriptionKey = isRw
    ? 'agentAccess.rwKillSwitchDescription'
    : 'agentAccess.killSwitchDescription'
  const killSwitchButtonKey = isRw
    ? 'agentAccess.rwKillSwitchButton'
    : 'agentAccess.killSwitchButton'

  const confirmDisconnectTitleKey = isRw
    ? 'agentAccess.rwConfirmDisconnectTitle'
    : 'agentAccess.confirmDisconnectTitle'
  const confirmDisconnectDescriptionKey = isRw
    ? 'agentAccess.rwConfirmDisconnectDescription'
    : 'agentAccess.confirmDisconnectDescription'
  const confirmDisconnectActionKey = isRw
    ? 'agentAccess.rwConfirmDisconnectAction'
    : 'agentAccess.confirmDisconnectAction'

  return (
    <>
      {/* Toggle row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Label htmlFor={toggleId} muted={false}>
              {t(toggleLabelKey)}
            </Label>
            {isRw && effectiveStatus.enabled && (
              <Badge variant="destructive" data-testid="mcp-rw-warning-badge">
                {t('agentAccess.rwEnabledWarning')}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{t(toggleDescriptionKey)}</p>
        </div>
        <Switch
          id={toggleId}
          checked={effectiveStatus.enabled}
          onCheckedChange={onToggle}
          aria-label={t(toggleLabelKey)}
          disabled={status === null}
        />
      </div>

      {/* Socket path */}
      <div className="space-y-2">
        <Label htmlFor={socketPathId} muted={false}>
          {t(socketPathLabelKey)}
        </Label>
        <div className="flex items-center gap-2">
          <code
            id={socketPathId}
            className="flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono break-all"
            data-testid={socketPathTestId}
          >
            {socketPath || '\u00A0'}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => onCopySocket(socketPath)}
            aria-label={t(copySocketLabelKey)}
            disabled={!socketPath}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {children}

      {/* Kill switch */}
      <div className="space-y-2">
        <Label muted={false}>{t(killSwitchLabelKey)}</Label>
        <p className="text-xs text-muted-foreground">
          {effectiveStatus.active_connections === 0
            ? t(killSwitchDescriptionNoneKey)
            : t(killSwitchDescriptionKey, {
                count: effectiveStatus.active_connections,
              })}
        </p>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={effectiveStatus.active_connections === 0}
          aria-label={t(killSwitchButtonKey)}
        >
          {t(killSwitchButtonKey)}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false)
        }}
        title={t(confirmDisconnectTitleKey)}
        description={t(confirmDisconnectDescriptionKey)}
        actionLabel={t(confirmDisconnectActionKey)}
        actionVariant="destructive"
        onAction={() => {
          setConfirmOpen(false)
          onDisconnect()
        }}
      />
    </>
  )
}
