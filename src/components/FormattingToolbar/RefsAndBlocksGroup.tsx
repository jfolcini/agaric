/**
 * Renderers for the popover-trigger toolbar buttons that can't go through
 * `renderConfigButton` because they open Radix `Popover`s anchored to
 * themselves: Format (#1958, inline marks), Turn into (#1960, block-type
 * transforms — replaced the old heading/code/callout/etc. buttons), and the
 * table picker / table-ops triggers. Their open/close state is owned by the
 * orchestrator and threaded in via props.
 */

import type { Editor } from '@tiptap/react'
import { Pilcrow, Table, Table2, Type } from 'lucide-react'
import type React from 'react'

import { FormatMenu } from '@/components/editor-toolbar/FormatMenu'
import { TablePicker } from '@/components/editor-toolbar/TablePicker'
import { TurnIntoMenu } from '@/components/editor-toolbar/TurnIntoMenu'

import { TableOpsSelector } from '../TableOpsSelector'
import { Button } from '../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { type RenderMode, Tip } from './shared'

interface FormatButtonProps {
  editor: Editor
  mode: RenderMode
  t: (key: string) => string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
}

/**
 * Render the "Format" popover trigger (#1958). Opens a `FormatMenu` holding the
 * inline mark toggles so formatting can be applied at the caret WITHOUT a
 * selection (and on touch, where the selection bubble is suppressed). Mirrors
 * the callout / table popover triggers; unlike them it needs no overflow-close
 * callback because the mark toggles intentionally keep the popover open so the
 * user can stack several marks.
 */
export function renderFormatButton({
  editor,
  mode,
  t,
  open,
  setOpen,
}: FormatButtonProps): React.ReactElement {
  if (mode === 'sentinel') {
    return (
      <Button variant="ghost" size="icon-xs" aria-hidden tabIndex={-1}>
        <Type className="h-3.5 w-3.5" />
      </Button>
    )
  }

  const trigger =
    mode === 'overflow' ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.format')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11"
        onPointerDown={(e) => {
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <Type className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.format')}</span>
      </Button>
    ) : (
      <Tip label={t('toolbar.formatTip')}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('toolbar.format')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onPointerDown={(e) => {
            e.preventDefault()
            setOpen((prev) => !prev)
          }}
        >
          <Type className="h-3.5 w-3.5" />
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
        // #1958 — keep focus in the editor while the Format popover is open
        // (don't auto-focus the popover on open, don't snap focus back to the
        // trigger on close). The mark toggles run `editor.chain().focus()
        // .toggle…()`, which set a STORED mark at an empty caret; if Radix
        // pulled focus into the popover and then returned it to the trigger,
        // the editor would blur and drop that stored mark before the user
        // could type. This mirrors the selection bubble, which never steals
        // focus from the editor.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <FormatMenu editor={editor} />
      </PopoverContent>
    </Popover>
  )
}

interface TurnIntoButtonProps {
  editor: Editor
  mode: RenderMode
  t: (key: string) => string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
}

/**
 * Render the "Turn into" popover trigger (#1960, `Pilcrow` icon). Hosts
 * `TurnIntoMenu` — the structural block-type transforms that replaced the
 * standalone Heading / Code / Callout / Blockquote / Ordered-list / Divider
 * buttons. Unlike Format it is a one-shot menu: picking an entry converts the
 * block and closes the popover (the menu calls back into `setOpen(false)`).
 */
export function renderTurnIntoButton({
  editor,
  mode,
  t,
  open,
  setOpen,
}: TurnIntoButtonProps): React.ReactElement {
  if (mode === 'sentinel') {
    return (
      <Button variant="ghost" size="icon-xs" aria-hidden tabIndex={-1}>
        <Pilcrow className="h-3.5 w-3.5" />
      </Button>
    )
  }

  const trigger =
    mode === 'overflow' ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.turnInto')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11"
        onPointerDown={(e) => {
          e.preventDefault()
          setOpen((prev) => !prev)
        }}
      >
        <Pilcrow className="h-3.5 w-3.5 mr-2" />
        <span>{t('toolbar.turnInto')}</span>
      </Button>
    ) : (
      <Tip label={t('toolbar.turnIntoTip')}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('toolbar.turnInto')}
          aria-haspopup="menu"
          aria-expanded={open}
          onPointerDown={(e) => {
            e.preventDefault()
            setOpen((prev) => !prev)
          }}
        >
          <Pilcrow className="h-3.5 w-3.5" />
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
        <TurnIntoMenu editor={editor} onClose={() => setOpen(false)} />
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
