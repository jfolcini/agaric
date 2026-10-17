/**
 * CreateAgentDialog — names a new MCP agent and picks its mode and spaces
 * (#5667). A bottom sheet on phones. A rejected create keeps the dialog open
 * with an inline alert, so the user can fix the name and retry.
 */

import type React from 'react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogBody } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { unwrap, validationCode } from '@/lib/app-error'
import { commands, type McpAgent, type McpAgentMode } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { useSpaceStore } from '@/stores/space'

export interface CreateAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs after the backend created the agent and before the dialog closes. */
  onCreated: (agent: McpAgent) => Promise<void>
  /** No `Dialog.Trigger` opens this dialog, so focus goes back here on close. */
  returnFocusTo: React.RefObject<HTMLButtonElement | null>
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
  returnFocusTo,
}: CreateAgentDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const spaces = useSpaceStore((s) => s.availableSpaces)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<McpAgentMode>('read_only')
  const [allSpaces, setAllSpaces] = useState(true)
  const [spaceIds, setSpaceIds] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)
  const nameId = useId()
  const modeLabelId = useId()
  const modeNoteId = useId()
  const allSpacesId = useId()
  const errorId = useId()

  // Each open starts from a blank form.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName('')
      setMode('read_only')
      setAllSpaces(true)
      setSpaceIds(new Set())
      setError(null)
    }
  }

  const canSubmit = name.trim() !== '' && (allSpaces || spaceIds.size > 0) && !submitting

  const handleSubmit = async () => {
    if (!canSubmit || inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    try {
      const agent = unwrap(
        await commands.createMcpAgent(name, mode, allSpaces ? null : [...spaceIds]),
      )
      await onCreated(agent)
      notify.success(t('agentAccess.agents.created'))
      onOpenChange(false)
    } catch (err) {
      logger.error('AgentAccessSettingsTab', 'failed to create agent', { mode, allSpaces }, err)
      const code = validationCode(err)
      setError(
        code === ValidationCode.DuplicateAgentName
          ? t('agentAccess.agents.duplicateName', { name: name.trim() })
          : code === ValidationCode.InvalidAgentName
            ? t('agentAccess.agents.invalidName')
            : t('agentAccess.agents.createFailed'),
      )
      notify.error(t('agentAccess.agents.createFailed'))
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const toggleSpace = (id: string, checked: boolean) => {
    setSpaceIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description, Footer } = parts

  const fields = (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={nameId} muted={false}>
          {t('agentAccess.agents.nameLabel')}
        </Label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          placeholder={t('agentAccess.agents.namePlaceholder')}
          aria-invalid={error !== null ? true : undefined}
          aria-describedby={error !== null ? errorId : undefined}
          autoComplete="off"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens on demand to take a name
          autoFocus
        />
        {error !== null && (
          <p id={errorId} className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <span id={modeLabelId} className="block text-sm font-medium">
          {t('agentAccess.agents.modeLabel')}
        </span>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => {
            if (value === 'read_only' || value === 'read_write') setMode(value)
          }}
          aria-labelledby={modeLabelId}
          aria-describedby={modeNoteId}
        >
          <ToggleGroupItem value="read_only">
            {t('agentAccess.agents.modeReadOnly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="read_write">
            {t('agentAccess.agents.modeReadWrite')}
          </ToggleGroupItem>
        </ToggleGroup>
        <p id={modeNoteId} className="text-xs text-muted-foreground">
          {t('agentAccess.agents.readOnlyNote')}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={allSpacesId}
            checked={allSpaces}
            onCheckedChange={(checked) => setAllSpaces(checked === true)}
          />
          <Label htmlFor={allSpacesId} muted={false}>
            {t('agentAccess.agents.allSpacesCheckbox')}
          </Label>
        </div>
        {!allSpaces && (
          <fieldset className="space-y-1 pl-6">
            <legend className="mb-1 text-sm font-medium">
              {t('agentAccess.agents.spacesLegend')}
            </legend>
            {spaces.map((space) => {
              const id = `${allSpacesId}-${space.id}`
              return (
                <div key={space.id} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={spaceIds.has(space.id)}
                    onCheckedChange={(checked) => toggleSpace(space.id, checked === true)}
                  />
                  <Label htmlFor={id} muted={false}>
                    {space.name}
                  </Label>
                </div>
              )
            })}
          </fieldset>
        )}
      </div>
    </div>
  )

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content
        data-testid="create-agent-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocusTo.current?.focus()
        }}
      >
        <Header>
          <Title>{t('agentAccess.agents.createTitle')}</Title>
          <Description>{t('agentAccess.agents.createDescription')}</Description>
        </Header>
        {/* `contents` keeps the body and footer as the dialog's flex children,
            with the submit button inside the form so Enter submits. */}
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          {parts.isMobile ? fields : <DialogBody>{fields}</DialogBody>}
          <Footer>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('agentAccess.agents.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit} aria-busy={submitting}>
              {t('agentAccess.agents.create')}
            </Button>
          </Footer>
        </form>
      </Content>
    </Root>
  )
}
