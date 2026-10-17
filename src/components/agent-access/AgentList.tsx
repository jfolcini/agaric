/**
 * AgentList — the MCP agents on this device (#5667): each one's mode, spaces
 * and last use, its two config snippets, and Revoke. Shown whether or not
 * agent access is on, since agents are set up before a client connects.
 */

import { Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CreateAgentDialog } from '@/components/agent-access/CreateAgentDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { claudeCodeCommand, claudeDesktopConfig } from '@/lib/agent-config'
import { unwrap } from '@/lib/app-error'
import { commands, type McpAgent, type SpaceRow } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useSpaceStore } from '@/stores/space'

export interface AgentListProps {
  /** The socket the copied configs point the bridge at. */
  socketPath: string
}

function spacesLabel(
  spaceIds: string[] | null,
  spaces: SpaceRow[],
  t: (key: string) => string,
): string {
  if (spaceIds === null) return t('agentAccess.agents.allSpaces')
  const names = spaces.filter((s) => spaceIds.includes(s.id)).map((s) => s.name)
  return names.length > 0 ? names.join(', ') : t('agentAccess.agents.noSpacesLeft')
}

export function AgentList({ socketPath }: AgentListProps): React.ReactElement {
  const { t } = useTranslation()
  const spaces = useSpaceStore((s) => s.availableSpaces)
  const [agents, setAgents] = useState<McpAgent[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<McpAgent | null>(null)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  const focusAddAfterRevoke = useRef(false)
  const headingId = useId()

  const load = useCallback(async () => {
    try {
      setAgents(unwrap(await commands.listMcpAgents()))
      setLoadFailed(false)
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to load agents', undefined, err)
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loads the agent list from IPC on mount; see #4407
    void load()
  }, [load])

  // The revoked row's button, where ConfirmDialog would return focus, is gone.
  useEffect(() => {
    if (revokeTarget === null && focusAddAfterRevoke.current) {
      focusAddAfterRevoke.current = false
      addButtonRef.current?.focus()
    }
  }, [revokeTarget])

  const copy = useCallback(
    async (text: string, successKey: string) => {
      try {
        await writeText(text)
        notify.success(t(successKey))
      } catch (err) {
        logger.warn('AgentAccessSettingsTab', 'clipboard write failed', undefined, err)
        notify.error(t('agentAccess.copyFailed'))
      }
    },
    [t],
  )

  const revoke = useCallback(async () => {
    if (revokeTarget === null) return
    try {
      unwrap(await commands.revokeMcpAgent(revokeTarget.id))
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to revoke agent', undefined, err)
      notify.error(t('agentAccess.agents.revokeFailed'))
      throw err
    }
    focusAddAfterRevoke.current = true
    notify.success(t('agentAccess.agents.revokeSuccess'))
    await load()
  }, [revokeTarget, load, t])

  const addButton = (
    <Button ref={addButtonRef} variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
      {t('agentAccess.agents.add')}
    </Button>
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 id={headingId} className="text-sm font-medium">
            {t('agentAccess.agents.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('agentAccess.agents.description')}</p>
          <p className="text-xs text-muted-foreground">
            {t('agentAccess.agents.pendingEnforcement')}
          </p>
        </div>
        {agents !== null && agents.length > 0 && addButton}
      </div>

      {loadFailed && (
        <p className="text-sm text-destructive" role="alert">
          {t('agentAccess.agents.loadFailed')}
        </p>
      )}

      {agents === null ? (
        !loadFailed && <LoadingSkeleton count={2} height="h-10" />
      ) : agents.length === 0 ? (
        <EmptyState
          compact
          headingLevel="p"
          message={t('agentAccess.agents.empty')}
          description={t('agentAccess.agents.emptyDescription')}
          action={<div className="mt-3">{addButton}</div>}
        />
      ) : (
        <ul className="divide-y rounded-md border" aria-labelledby={headingId}>
          {agents.map((agent) => (
            <li key={agent.id} className="space-y-2 p-3" data-testid="mcp-agent-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-all">{agent.name}</span>
                <Badge tone={agent.mode === 'read_write' ? 'destructive' : 'secondary'}>
                  {agent.mode === 'read_write'
                    ? t('agentAccess.agents.modeReadWrite')
                    : t('agentAccess.agents.modeReadOnly')}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {spacesLabel(agent.space_ids, spaces, t)} ·{' '}
                {agent.last_used_ms === null
                  ? t('agentAccess.agents.neverUsed')
                  : t('agentAccess.agents.lastUsed', {
                      when: formatRelativeTime(agent.last_used_ms, t),
                    })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('agentAccess.agents.copyDesktopAria', { name: agent.name })}
                  onClick={() =>
                    void copy(
                      claudeDesktopConfig(agent, socketPath),
                      'agentAccess.claudeConfigCopied',
                    )
                  }
                >
                  {t('agentAccess.agents.copyDesktopButton')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('agentAccess.agents.copyCodeAria', { name: agent.name })}
                  onClick={() =>
                    void copy(
                      claudeCodeCommand(agent, socketPath),
                      'agentAccess.agents.codeCommandCopied',
                    )
                  }
                >
                  {t('agentAccess.agents.copyCodeButton')}
                </Button>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  ariaLabel={t('agentAccess.agents.revokeAria', { name: agent.name })}
                  tooltip={t('agentAccess.agents.revoke')}
                  onClick={() => setRevokeTarget(agent)}
                >
                  <Trash2 />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
        returnFocusTo={addButtonRef}
      />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
        titleKey="agentAccess.agents.revokeTitle"
        descriptionKey="agentAccess.agents.revokeDescription"
        confirmKey="agentAccess.agents.revoke"
        values={{ name: revokeTarget?.name ?? '' }}
        variant="destructive"
        onConfirm={revoke}
      />
    </div>
  )
}
