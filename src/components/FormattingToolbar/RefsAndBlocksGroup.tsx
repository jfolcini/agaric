/**
 * Renderers for the heading-level and code-block-language popover
 * triggers that live in Group 0 of `FormattingToolbar` (MAINT-219).
 *
 * These two buttons can't go through `renderConfigButton` because they
 * open Radix `Popover`s anchored to themselves. Their open/close state
 * is owned by the orchestrator and threaded in via props so the
 * orchestrator can also flip it from the overflow popover's selection
 * handlers (MAINT-221 contract).
 */

import type { Editor } from '@tiptap/react'
import { FileCode2, Heading } from 'lucide-react'
import type React from 'react'

import { LANG_SHORT, toolbarActiveClass } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

import { CodeLanguageSelector } from '../CodeLanguageSelector'
import { HeadingLevelSelector } from '../HeadingLevelSelector'
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
