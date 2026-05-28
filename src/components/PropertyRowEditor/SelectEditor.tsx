/**
 * SelectEditor — renders a Radix Select with the property's allowed options.
 *
 * The trailing "edit options" / "locked" affordance lives in
 * {@link SelectOptionsAffordance} so the orchestrator can place it outside
 * the editor slot (the affordance is a sibling of the editor, not a child).
 */

import { ArrowDown, ArrowUp, Lock, Pencil, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import type { SelectEditorState, SelectOptionsEditorState } from './usePropertyRowEditor'

export interface SelectEditorProps {
  state: SelectEditorState
  ariaLabel: string
}

export function SelectEditor({ state, ariaLabel }: SelectEditorProps) {
  const { t } = useTranslation()
  const { localValue, options, handleSelectChange } = state
  return (
    <Select value={localValue || '__none__'} onValueChange={handleSelectChange}>
      <SelectTrigger className="w-full" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">{t('pageProperty.emptyOption')}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export interface SelectOptionsAffordanceProps {
  propKey: string
  locked: boolean
  state: SelectOptionsEditorState
}

export function SelectOptionsAffordance({ propKey, locked, state }: SelectOptionsAffordanceProps) {
  const { t } = useTranslation()
  if (locked) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground"
              data-testid={`locked-options-${propKey}`}
            >
              <Lock className="h-3 w-3" aria-hidden="true" />
              {t('propertiesView.optionsLocked')}
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('propertiesView.optionsLockedTooltip')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return <SelectOptionsPopover propKey={propKey} state={state} />
}

interface SelectOptionsPopoverProps {
  propKey: string
  state: SelectOptionsEditorState
}

function SelectOptionsPopover({ propKey, state }: SelectOptionsPopoverProps) {
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
    handleRemove,
    handleMove,
    handleSave,
  } = state
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          onClick={handleOpen}
          aria-label={t('pageProperty.editOptionsLabel', { key: propKey })}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 space-y-2 p-3 max-w-[calc(100vw-2rem)]"
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
        <ScrollArea className="max-h-32">
          <div className="space-y-1">
            {options.map((opt, idx) => (
              <SelectOptionRow
                key={opt}
                opt={opt}
                idx={idx}
                total={options.length}
                onMove={handleMove}
                onRemove={handleRemove}
              />
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
        <Button size="sm" className="w-full" onClick={handleSave}>
          {t('pageProperty.saveOptionsButton')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

interface SelectOptionRowProps {
  opt: string
  idx: number
  total: number
  onMove: (opt: string, direction: 'up' | 'down') => void
  onRemove: (opt: string) => void
}

function SelectOptionRow({ opt, idx, total, onMove, onRemove }: SelectOptionRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-1 rounded px-1 py-0.5 text-sm hover:bg-accent">
      <span className="truncate flex-1">{opt}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => onMove(opt, 'up')}
        disabled={idx === 0}
        aria-label={t('properties.moveOptionUp', { option: opt })}
      >
        <ArrowUp className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => onMove(opt, 'down')}
        disabled={idx === total - 1}
        aria-label={t('properties.moveOptionDown', { option: opt })}
      >
        <ArrowDown className="h-3 w-3" />
      </Button>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
        onClick={() => onRemove(opt)}
        aria-label={t('pageProperty.removeOptionLabel', { option: opt })}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
