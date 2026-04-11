import {
  BookTemplate,
  Download,
  ExternalLink,
  LayoutTemplate,
  Link,
  MoreVertical,
  Redo2,
  Settings2,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface PageHeaderMenuProps {
  canRedo: boolean
  kebabOpen: boolean
  isTemplate: boolean
  isJournalTemplate: boolean
  onUndo: () => void
  onRedo: () => void
  onKebabOpenChange: (open: boolean) => void
  onAddAlias: () => void
  onAddTag: () => void
  onAddProperty: () => void
  onToggleTemplate: () => void
  onToggleJournalTemplate: () => void
  onExport: () => void
  onDeleteRequest: () => void
  onOpenInNewTab?: (() => void) | undefined
}

export function PageHeaderMenu({
  canRedo,
  kebabOpen,
  isTemplate,
  isJournalTemplate,
  onUndo,
  onRedo,
  onKebabOpenChange,
  onAddAlias,
  onAddTag,
  onAddProperty,
  onToggleTemplate,
  onToggleJournalTemplate,
  onExport,
  onDeleteRequest,
  onOpenInNewTab,
}: PageHeaderMenuProps) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('pageHeader.undoAction')}
        onClick={onUndo}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('pageHeader.redoAction')}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggleTemplate}
            aria-label={t('pageHeader.toggleTemplate')}
            aria-pressed={isTemplate}
          >
            <LayoutTemplate className={cn('h-3.5 w-3.5', isTemplate && 'text-primary')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isTemplate ? t('pageHeader.templateActive') : t('pageHeader.toggleTemplate')}
        </TooltipContent>
      </Tooltip>
      <Popover open={kebabOpen} onOpenChange={onKebabOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={t('pageHeader.pageActions')}>
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-56 p-1 max-w-[calc(100vw-2rem)]"
          aria-label={t('pageHeader.pageActions')}
        >
          {onOpenInNewTab != null && (
            <>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={onOpenInNewTab}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('tabs.openInNewTab')}
              </button>
              <hr className="my-1 h-px bg-border border-none" />
            </>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onAddAlias}
          >
            <Link className="h-3.5 w-3.5" />
            {t('pageHeader.menuAddAlias')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onAddTag}
          >
            <Tag className="h-3.5 w-3.5" />
            {t('pageHeader.menuAddTag')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onAddProperty}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('pageHeader.menuAddProperty')}
          </button>
          <hr className="my-1 h-px bg-border border-none" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onToggleTemplate}
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            {isTemplate ? t('pageHeader.removeTemplate') : t('pageHeader.saveAsTemplate')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onToggleJournalTemplate}
          >
            <BookTemplate className="h-3.5 w-3.5" />
            {isJournalTemplate
              ? t('pageHeader.removeJournalTemplate')
              : t('pageHeader.setJournalTemplate')}
          </button>
          <hr className="my-1 h-px bg-border border-none" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onExport}
          >
            <Download className="h-3.5 w-3.5" />
            {t('pageHeader.exportMarkdown')}
          </button>
          <hr className="my-1 h-px bg-border border-none" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={onDeleteRequest}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('pageHeader.deletePage')}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
