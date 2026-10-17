/**
 * McpStatusSection — the MCP socket's switch, and while it is on, its path
 * and connections with a confirmed Disconnect all.
 *
 * Everything below the switch renders only while it is on: a socket path
 * and a connection count describe a server that is not running when it is
 * off. Which agent may do what is the agents card's business (#5667).
 *
 * Toggling and disconnect IPC calls are owned by the parent — this
 * component just calls back into `onToggle` / `onDisconnect` so the
 * parent's logger label (`'AgentAccessSettingsTab'`) stays the source
 * of truth on the error paths.
 */

import { Copy } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { McpStatus } from '@/lib/bindings'

export interface McpStatusSectionProps {
  status: McpStatus | null
  onToggle: (next: boolean) => void
  onCopySocket: (path: string) => void
  onDisconnect: () => void
}

export function McpStatusSection({
  status,
  onToggle,
  onCopySocket,
  onDisconnect,
}: McpStatusSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false)

  const enabled = status?.enabled ?? false
  const socketPath = status?.socket_path ?? ''
  const activeConnections = status?.active_connections ?? 0

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="mcp-toggle" muted={false}>
            {t('agentAccess.toggleLabel')}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">{t('agentAccess.toggleDescription')}</p>
        </div>
        <Switch
          id="mcp-toggle"
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={t('agentAccess.toggleLabel')}
          disabled={status === null}
        />
      </div>

      {enabled && (
        <>
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
                {socketPath || ' '}
              </code>
              <IconButton
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => onCopySocket(socketPath)}
                tooltip={t('agentAccess.copySocketPathLabel')}
                ariaLabel={t('agentAccess.copySocketPathLabel')}
                disabled={!socketPath}
              >
                <Copy />
              </IconButton>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-medium">{t('agentAccess.killSwitchLabel')}</h2>
            <p className="text-xs text-muted-foreground">
              {activeConnections === 0
                ? t('agentAccess.killSwitchDescriptionNone')
                : t('agentAccess.killSwitchDescription', { count: activeConnections })}
            </p>
            {activeConnections > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                aria-label={t('agentAccess.killSwitchButton')}
              >
                {t('agentAccess.killSwitchButton')}
              </Button>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false)
        }}
        titleKey="agentAccess.confirmDisconnectTitle"
        descriptionKey="agentAccess.confirmDisconnectDescription"
        confirmKey="agentAccess.confirmDisconnectAction"
        variant="destructive"
        onConfirm={() => {
          setConfirmOpen(false)
          onDisconnect()
        }}
      />
    </>
  )
}
