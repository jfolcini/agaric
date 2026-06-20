/**
 * Renderers for the heading-level and code-block-language popover
 * Triggers that live in Group 0 of `FormattingToolbar`.
 *
 * These two buttons can't go through `renderConfigButton` because they
 * open Radix `Popover`s anchored to themselves. Their open/close state
 * is owned by the orchestrator and threaded in via props so the
 * orchestrator can also flip it from the overflow popover's selection
 * Handlers (contract).
 */

import type { Editor } from '@tiptap/react'
import { FileCode2, Heading, Info, Table, Table2 } from 'lucide-react'
import type React from 'react'

import { CalloutTypeSelector } from '@/components/editor-toolbar/CalloutTypeSelector'
import { CodeLanguageSelector } from '@/components/editor-toolbar/CodeLanguageSelector'
import { HeadingLevelSelector } from '@/components/editor-toolbar/HeadingLevelSelector'
import { TablePicker } from '@/components/editor-toolbar/TablePicker'
import { LANG_SHORT, toolbarActiveClass } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

import { TableOpsSelector } from '../TableOpsSelector'
import { Button } from '../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { type RenderMode, Tip, tooltipWithShortcut } from './shared'

interface CodeBlockButtonProps {
  editor: Editor
  mode: RenderMode
  t: (key: string) => string
  isCodeBlock: boolean
  codeBlockLanguage: string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  onOverflowClose: () => void
}

/**
 * Render the code-block popover trigger. When visible inline this
 * mounts the full Popover wrapper so the heading-level / language
 * selector opens anchored to the button. In `overflow` mode we mount
 * a NESTED Popover wrapper anchored to the overflow row — Radix
 * supports nested popovers.
 */
export function renderCodeBlockButton({
  editor,
  mode,
  t,
  isCodeBlock,
  codeBlockLanguage,
  open,
  setOpen,
  onOverflowClose,
}: CodeBlockButtonProps): React.ReactElement {
  // #215 P2-8 — persistent label so the inactive button doesn't read as
  // icon-only/disabled. Active state surfaces the language short code.
  const codeBlockLabel =
    isCodeBlock && codeBlockLanguage ? (LANG_SHORT[codeBlockLanguage] ?? codeBlockLanguage) : 'Code'

  if (mode === 'sentinel') {
    // Just the button shape — skip Popover wrapper to avoid duplicating
    // popover content in the DOM. Must match the real button's footprint so
    // `useToolbarOverflow`'s width measurement stays accurate.
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-hidden
        tabIndex={-1}
        className={cn('h-7 gap-1 px-1.5 text-xs', isCodeBlock && toolbarActiveClass)}
      >
        <FileCode2 className="h-3.5 w-3.5" />
        <span className="font-medium">{codeBlockLabel}</span>
      </Button>
    )
  }

  const tipLabel = tooltipWithShortcut(t('toolbar.codeBlockLanguage'), 'codeBlock')

  const trigger =
    mode === 'overflow' ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.codeBlockLanguage')}
        aria-pressed={isCodeBlock}
        className={cn(
          'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
          isCodeBlock && toolbarActiveClass,
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <FileCode2 className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.codeBlockLanguage')}</span>
        {isCodeBlock && codeBlockLanguage && (
          <span className="ml-auto text-xs font-bold">
            {LANG_SHORT[codeBlockLanguage] ?? codeBlockLanguage}
          </span>
        )}
      </Button>
    ) : (
      <Tip label={tipLabel}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('toolbar.codeBlockLanguage')}
          aria-pressed={isCodeBlock}
          className={cn('h-7 gap-1 px-1.5 text-xs', isCodeBlock && toolbarActiveClass)}
          onPointerDown={(e) => {
            e.preventDefault()
            setOpen((prev) => !prev)
          }}
        >
          <FileCode2 className="h-3.5 w-3.5" />
          <span className="font-medium">{codeBlockLabel}</span>
        </Button>
      </Tip>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-2rem)] p-1"
        data-editor-portal
      >
        <CodeLanguageSelector
          editor={editor}
          isCodeBlock={isCodeBlock}
          currentLanguage={codeBlockLanguage}
          onClose={() => {
            setOpen(false)
            if (mode === 'overflow') onOverflowClose()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

interface HeadingButtonProps {
  editor: Editor
  mode: RenderMode
  t: (key: string) => string
  headingLevel: number
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  onOverflowClose: () => void
}

/** Render the heading popover trigger — same shape as code-block. */
export function renderHeadingButton({
  editor,
  mode,
  t,
  headingLevel,
  open,
  setOpen,
  onOverflowClose,
}: HeadingButtonProps): React.ReactElement {
  // NOTE: the heading button keeps its icon-only form — the Heading icon is
  // itself an "H" glyph, so a persistent "H" text label would render a
  // redundant "H H" (verified at runtime). The active-level badge is enough.
  // (#215 P2-8 persistent labels apply to the code-block button only.)
  if (mode === 'sentinel') {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-hidden
        tabIndex={-1}
        className={cn(headingLevel > 0 && toolbarActiveClass)}
      >
        <Heading className="h-3.5 w-3.5" />
        {headingLevel > 0 && <span className="text-xs font-bold">{headingLevel}</span>}
      </Button>
    )
  }

  const trigger =
    mode === 'overflow' ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.headingLevel')}
        aria-pressed={headingLevel > 0}
        className={cn(
          'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
          headingLevel > 0 && toolbarActiveClass,
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <Heading className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.headingLevel')}</span>
        {headingLevel > 0 && <span className="ml-auto text-xs font-bold">{headingLevel}</span>}
      </Button>
    ) : (
      <Tip label={t('toolbar.headingTip')}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('toolbar.headingLevel')}
          aria-pressed={headingLevel > 0}
          className={cn(headingLevel > 0 && toolbarActiveClass)}
          onPointerDown={(e) => {
            e.preventDefault()
            setOpen((prev) => !prev)
          }}
        >
          <Heading className="h-3.5 w-3.5" />
          {headingLevel > 0 && <span className="text-xs font-bold">{headingLevel}</span>}
        </Button>
      </Tip>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-2rem)] p-1"
        data-editor-portal
      >
        <HeadingLevelSelector
          editor={editor}
          headingLevel={headingLevel}
          onClose={() => {
            setOpen(false)
            if (mode === 'overflow') onOverflowClose()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

interface CalloutButtonProps {
  mode: RenderMode
  t: (key: string) => string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  onOverflowClose: () => void
}

/**
 * Render the callout-type popover trigger (#215). Mirrors the code-block /
 * heading popover triggers: the button opens a `CalloutTypeSelector` listing
 * the five variants; selecting one dispatches `INSERT_CALLOUT` with the chosen
 * `type`. Unlike those, it needs no editor — the selector dispatches an event
 * that `useBlockTreeEventListeners` consumes.
 */
export function renderCalloutButton({
  mode,
  t,
  open,
  setOpen,
  onOverflowClose,
}: CalloutButtonProps): React.ReactElement {
  if (mode === 'sentinel') {
    return (
      <Button variant="ghost" size="icon-xs" aria-hidden tabIndex={-1}>
        <Info className="h-3.5 w-3.5" />
      </Button>
    )
  }

  const trigger =
    mode === 'overflow' ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.callout')}
        className="justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11"
        onPointerDown={(e) => {
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <Info className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.callout')}</span>
      </Button>
    ) : (
      <Tip label={t('toolbar.calloutTip')}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('toolbar.callout')}
          onPointerDown={(e) => {
            e.preventDefault()
            setOpen((prev) => !prev)
          }}
        >
          <Info className="h-3.5 w-3.5" />
        </Button>
      </Tip>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-2rem)] p-1"
        data-editor-portal
      >
        <CalloutTypeSelector
          onClose={() => {
            setOpen(false)
            if (mode === 'overflow') onOverflowClose()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

interface TableOpsButtonProps {
  editor: Editor
  mode: RenderMode
  t: (key: string) => string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  onOverflowClose: () => void
}

/**
 * Render the table-operations popover trigger (#215). Only added to the
 * toolbar item list when the selection is inside a table (see
 * `buildToolbarItems`'s `includeTableOps`), so unlike the other triggers it
 * has no inactive/empty state — it simply isn't present otherwise. Opens a
 * `TableOpsSelector` whose items run TipTap table commands on the editor.
 */
export function renderTableOpsButton({
  editor,
  mode,
  t,
  open,
  setOpen,
  onOverflowClose,
}: TableOpsButtonProps): React.ReactElement {
  if (mode === 'sentinel') {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-hidden
        tabIndex={-1}
        className="h-7 gap-1 px-1.5 text-xs"
      >
        <Table2 className="h-3.5 w-3.5" />
        <span className="font-medium">{t('toolbar.tableOps')}</span>
      </Button>
    )
  }

  const trigger =
    mode === 'overflow' ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.tableOps')}
        className="justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11"
        onPointerDown={(e) => {
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <Table2 className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.tableOps')}</span>
      </Button>
    ) : (
      <Tip label={t('toolbar.tableOpsTip')}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('toolbar.tableOps')}
          className="h-7 gap-1 px-1.5 text-xs"
          onPointerDown={(e) => {
            e.preventDefault()
            setOpen((prev) => !prev)
          }}
        >
          <Table2 className="h-3.5 w-3.5" />
          <span className="font-medium">{t('toolbar.tableOps')}</span>
        </Button>
      </Tip>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-2rem)] p-1"
        data-editor-portal
      >
        <TableOpsSelector
          editor={editor}
          onClose={() => {
            setOpen(false)
            if (mode === 'overflow') onOverflowClose()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

interface TablePickerButtonProps {
  editor: Editor
  mode: RenderMode
  t: (key: string) => string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  onOverflowClose: () => void
}

/**
 * Render the table-insert grid-picker trigger (#215b). Mirrors the callout /
 * table-ops popover triggers; opens a `TablePicker` grid whose selection
 * inserts an N×M table via the same `insertTable` path as the `/table` slash
 * command. Unlike the table-ops trigger this is always present (it inserts a
 * new table) — it does not depend on the selection being inside a table.
 */
export function renderTablePickerButton({
  editor,
  mode,
  t,
  open,
  setOpen,
  onOverflowClose,
}: TablePickerButtonProps): React.ReactElement {
  if (mode === 'sentinel') {
    return (
      <Button variant="ghost" size="icon-xs" aria-hidden tabIndex={-1}>
        <Table className="h-3.5 w-3.5" />
      </Button>
    )
  }

  const trigger =
    mode === 'overflow' ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.insertTable')}
        className="justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11"
        onPointerDown={(e) => {
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <Table className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.insertTable')}</span>
      </Button>
    ) : (
      <Tip label={t('toolbar.insertTableTip')}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('toolbar.insertTable')}
          onPointerDown={(e) => {
            e.preventDefault()
            setOpen((prev) => !prev)
          }}
        >
          <Table className="h-3.5 w-3.5" />
        </Button>
      </Tip>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-2rem)] p-1"
        data-editor-portal
      >
        <TablePicker
          editor={editor}
          onClose={() => {
            setOpen(false)
            if (mode === 'overflow') onOverflowClose()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
