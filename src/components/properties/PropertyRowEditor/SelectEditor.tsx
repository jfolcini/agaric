/**
 * SelectEditor — renders a Radix Select with the property's allowed options.
 *
 * The trailing "edit options" affordance lives in
 * {@link SelectOptionsPopover} so the orchestrator can place it outside
 * the editor slot (the affordance is a sibling of the editor, not a child).
 * Settings' options editor is the same popover behind its own trigger.
 */

import { ArrowDown, ArrowUp, Check, Pencil, Plus, X } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SelectEditorState } from '@/components/properties/PropertyRowEditor/usePropertyRowEditor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SelectOptionsEditorState } from '@/hooks/useSelectOptionsDraft'

export interface SelectEditorProps {
  state: SelectEditorState
  ariaLabel: string
  /** The stored value when it is none of the options, else null. */
  unfitValue: string | null
}

export function SelectEditor({ state, ariaLabel, unfitValue }: SelectEditorProps) {
  const { t } = useTranslation()
  const { localValue, options, handleSelectChange } = state
  return (
    <Select value={localValue || '__none__'} onValueChange={handleSelectChange}>
      <SelectTrigger className="w-full" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">{t('pageProperty.emptyOption')}</SelectItem>
        {/* A Radix Select shows a value no item carries as empty. */}
        {unfitValue !== null && (
          <SelectItem value={unfitValue} disabled>
            {unfitValue}
          </SelectItem>
        )}
        {options.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export interface SelectOptionsPopoverProps {
  propKey: string
  state: SelectOptionsEditorState
  /** What opens the editor; the pencil icon button when omitted. */
  trigger?: React.ReactElement
}

export function SelectOptionsPopover({ propKey, state, trigger }: SelectOptionsPopoverProps) {
  const { t } = useTranslation()
  const {
    open,
    setOpen,
    options,
    newOptionInput,
    setNewOptionInput,
    canAddOption,
    handleOpen,
    handleAdd,
    handleSave,
  } = state
  return (
    <Popover open={open} onOpenChange={(next) => (next ? handleOpen() : setOpen(false))}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-label={t('pageProperty.editOptionsLabel', { key: propKey })}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-64 space-y-2 p-3 max-w-[calc(100vw-2rem)]"
        aria-label={t('pageProperty.editOptionsLabel', { key: propKey })}
      >
        <div
          className="flex items-center justify-between"
          data-testid={`options-editor-header-${propKey}`}
        >
          <span className="text-xs font-medium text-muted-foreground">
            {t('pageProperty.editOptionsLabel', { key: propKey })}
          </span>
          <Badge tone="outline" className="text-xs" data-testid="options-count-badge">
            {t('properties.optionsCount', { count: options.length })}
          </Badge>
        </div>
        <ScrollArea className="max-h-40">
          <div className="space-y-1">
            {options.map((opt, idx) => (
              <SelectOptionRow key={opt} opt={opt} idx={idx} state={state} />
            ))}
          </div>
        </ScrollArea>
        <div className="flex gap-1">
          <Input
            className="h-7 flex-1 text-xs"
            placeholder={t('pageProperty.newOptionPlaceholder')}
            value={newOptionInput}
            onChange={(e) => setNewOptionInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAdd()
              }
            }}
            aria-label={t('pageProperty.newOptionLabel')}
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={handleAdd}
            disabled={!canAddOption}
            aria-label={t('pageProperty.addOptionLabel')}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        <Button size="sm" className="w-full" onClick={() => void handleSave()}>
          {t('pageProperty.saveOptionsButton')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

interface SelectOptionRowProps {
  opt: string
  idx: number
  state: SelectOptionsEditorState
}

function SelectOptionRow({ opt, idx, state }: SelectOptionRowProps) {
  const { t } = useTranslation()
  const { options, saved, handleMove, handleRemove, handleRename } = state
  // The new name while the row is being renamed, else null.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (renaming !== null && handleRename) {
    // Add trims its name too; an untrimmed copy would look like the option it repeats.
    const next = renaming.trim()
    const taken = next !== opt && saved.includes(next)
    const canSubmit = !busy && next !== '' && next !== opt && !taken
    return (
      <form
        className="space-y-1 rounded px-1 py-0.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSubmit) return
          setBusy(true)
          // `handleRename` reports its own failure; never rejects.
          void handleRename(opt, next).then((ok) => {
            setBusy(false)
            if (ok) setRenaming(null)
          })
        }}
      >
        <div className="flex items-center gap-1">
          <Input
            className="h-7 flex-1 text-xs"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            aria-label={t('properties.renameOptionInput', { option: opt })}
            aria-invalid={taken}
            aria-describedby={taken ? `option-taken-${idx}` : undefined}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user just asked to rename this option; the field it opens is where they type
            autoFocus
          />
          <IconButton
            type="submit"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            disabled={!canSubmit}
            tooltip={t('properties.saveOptionName')}
            ariaLabel={t('properties.saveOptionName')}
          >
            <Check className="h-3 w-3" />
          </IconButton>
          <IconButton
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            onClick={() => setRenaming(null)}
            tooltip={t('properties.cancelOptionRename')}
            ariaLabel={t('properties.cancelOptionRename')}
          >
            <X className="h-3 w-3" />
          </IconButton>
        </div>
        {taken && (
          <p id={`option-taken-${idx}`} className="text-xs text-destructive">
            {t('properties.optionTaken')}
          </p>
        )}
      </form>
    )
  }
  return (
    <div className="flex items-center justify-between gap-1 rounded px-1 py-0.5 text-sm hover:bg-accent">
      <span className="truncate flex-1">{opt}</span>
      {handleRename && saved.includes(opt) && (
        <IconButton
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          onClick={() => setRenaming(opt)}
          tooltip={t('properties.renameOption', { option: opt })}
          ariaLabel={t('properties.renameOption', { option: opt })}
        >
          <Pencil className="h-3 w-3" />
        </IconButton>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => handleMove(opt, 'up')}
        disabled={idx === 0}
        aria-label={t('properties.moveOptionUp', { option: opt })}
      >
        <ArrowUp className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => handleMove(opt, 'down')}
        disabled={idx === options.length - 1}
        aria-label={t('properties.moveOptionDown', { option: opt })}
      >
        <ArrowDown className="h-3 w-3" />
      </Button>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
        onClick={() => handleRemove(opt)}
        aria-label={t('pageProperty.removeOptionLabel', { option: opt })}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
