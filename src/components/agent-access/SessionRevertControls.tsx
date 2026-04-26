/**
 * SessionRevertControls — bulk-revert UX for a single MCP agent session.
 *
 * Renders the session-header `<li>` that sits above the first-seen
 * (newest-first) activity row of a session that has ≥ 2 undoable ops.
 * The header carries:
 *   - a short pluralized count label ("5 agent actions") for sighted
 *     users;
 *   - a "Revert session" button whose `aria-label` + tooltip carry the
 *     full verb ("Revert this agent session (5 actions)") for screen
 *     readers.
 *
 * Extracted from AgentAccessSettingsTab.tsx for testability — the
 * confirm-dialog flow + state lives in ActivityFeed.tsx, this
 * component is purely presentational so the feed can render one
 * instance per session header without leaking per-instance state.
 */

import { Undo2 } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface SessionRevertControlsProps {
  sessionId: string
  opCount: number
  isReverting: boolean
  onClick: () => void
}

export function SessionRevertControls({
  sessionId,
  opCount,
  isReverting,
  onClick,
}: SessionRevertControlsProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <li
      className="flex items-center justify-between gap-3 px-3 py-2 bg-muted/30 text-xs text-muted-foreground border-b"
      data-testid="mcp-activity-session-header"
      data-session-id={sessionId}
    >
      {/*
       * Visible label = short pluralized count
       * ("5 agent actions"). Distinct from the
       * button's `aria-label` / tooltip, which
       * carry the full verb ("Revert this agent
       * session (5 actions)") for screen readers.
       */}
      <span className="font-medium">
        {t('agentAccess.revertSession.headerLabel', {
          count: opCount,
        })}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onClick}
            disabled={isReverting}
            aria-busy={isReverting}
            aria-label={t('agentAccess.revertSession.buttonAriaLabel', {
              count: opCount,
            })}
            data-testid="mcp-activity-revert-session"
          >
            {isReverting ? (
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
            count: opCount,
          })}
        </TooltipContent>
      </Tooltip>
    </li>
  )
}
