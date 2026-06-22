/**
 * TurnIntoMenu — content of the always-visible toolbar's "Turn into" popover
 * (#1960). Replaces the standalone Heading / Code block / Callout / Blockquote /
 * Ordered-list / Divider toolbar buttons with one structural menu.
 *
 * Two parts:
 *  1. Turn-into list — every block-type transform (paragraph, headings 1–6,
 *     bullet / numbered list, quote, code, callout) iterated from the canonical
 *     `TURN_INTO_OPTIONS` so labels/icons never drift from the slash `/turn`
 *     family and the context-menu Turn-into group. Each row dispatches
 *     `TURN_INTO_BLOCK` (→ `convertBlockContent` + `applyContentEdit`) and closes
 *     the popover (one-shot). Divider is appended as the structural INSERT it is
 *     (`INSERT_DIVIDER` — there is no "divider" block type to convert to).
 *  2. Contextual sub-picker — preserves the rich options the removed buttons
 *     carried: when the focused block is a code block, the `CodeLanguageSelector`
 *     (language list); when it is a callout, the `CalloutTypeSelector` (5 types).
 *     Shown only for the matching active type, so nothing is lost by dropping the
 *     standalone buttons.
 *
 * Clicks use `onPointerDown + preventDefault` so focus stays in the editor and
 * the focus-keyed block command bus still targets the focused block (mirrors the
 * existing toolbar popover triggers).
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { Minus } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { CalloutTypeSelector } from '@/components/editor-toolbar/CalloutTypeSelector'
import { CodeLanguageSelector } from '@/components/editor-toolbar/CodeLanguageSelector'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { dispatchBlockEvent } from '@/lib/block-events'
import { TURN_INTO_OPTIONS, turnIntoTypeKey } from '@/lib/slash-commands'
import { toolbarActiveClass } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

interface TurnIntoMenuProps {
  editor: Editor
  /** Close the hosting popover after a one-shot turn-into selection. */
  onClose: () => void
}

export function TurnIntoMenu({ editor, onClose }: TurnIntoMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const state = useEditorState({
    editor,
    selector: (ctx) => {
      const blockquote = ctx.editor.isActive('blockquote')
      let headingLevel = 0
      for (let lvl = 1; lvl <= 6; lvl++) {
        if (ctx.editor.isActive('heading', { level: lvl })) {
          headingLevel = lvl
          break
        }
      }
      return {
        headingLevel,
        blockquote,
        codeBlock: ctx.editor.isActive('codeBlock'),
        bulletList: ctx.editor.isActive('bulletList'),
        orderedList: ctx.editor.isActive('orderedList'),
        calloutType: blockquote
          ? ((ctx.editor.getAttributes('blockquote')['calloutType'] as string | null) ?? null)
          : null,
        codeLanguage: ctx.editor.isActive('codeBlock')
          ? ((ctx.editor.getAttributes('codeBlock')['language'] as string) ?? '')
          : '',
      }
    },
  })

  const isActive = (blockType: string): boolean => {
    if (blockType === 'paragraph') {
      return (
        !state.blockquote &&
        !state.codeBlock &&
        !state.bulletList &&
        !state.orderedList &&
        state.headingLevel === 0
      )
    }
    if (blockType.length === 2 && blockType[0] === 'h') {
      return state.headingLevel === Number(blockType[1])
    }
    if (blockType === 'quote') return state.blockquote && state.calloutType === null
    if (blockType === 'code') return state.codeBlock
    if (blockType === 'numbered-list') return state.orderedList
    if (blockType === 'bullet-list') return state.bulletList
    if (blockType === 'callout') return state.blockquote && state.calloutType !== null
    return false
  }

  const rowClass = 'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11'

  return (
    <div className="flex flex-col gap-0.5 min-w-44">
      <div role="menu" aria-label={t('toolbar.turnInto')} className="flex flex-col gap-0.5">
        {TURN_INTO_OPTIONS.map((opt) => {
          const active = isActive(opt.blockType)
          return (
            <Button
              key={opt.id}
              role="menuitemradio"
              aria-checked={active ? 'true' : 'false'}
              variant="ghost"
              size="sm"
              className={cn(rowClass, active && toolbarActiveClass)}
              onPointerDown={(e) => {
                e.preventDefault()
                dispatchBlockEvent('TURN_INTO_BLOCK', { type: opt.blockType })
                onClose()
              }}
            >
              <opt.icon className="h-3.5 w-3.5 mr-2" />
              <span>{t(turnIntoTypeKey(opt.blockType))}</span>
            </Button>
          )
        })}
        <Button
          role="menuitem"
          variant="ghost"
          size="sm"
          aria-label={t('toolbar.divider')}
          className={rowClass}
          onPointerDown={(e) => {
            e.preventDefault()
            dispatchBlockEvent('INSERT_DIVIDER')
            onClose()
          }}
        >
          <Minus className="h-3.5 w-3.5 mr-2" />
          <span>{t('toolbar.divider')}</span>
        </Button>
      </div>

      {/* Contextual sub-picker — language for code blocks, type for callouts.
          Rendered OUTSIDE the `role="menu"` above: its input/buttons are not
          valid menu children (aria-required-children). */}
      {state.codeBlock && (
        <>
          <Separator className="my-1" />
          <CodeLanguageSelector
            editor={editor}
            isCodeBlock
            currentLanguage={state.codeLanguage}
            onClose={onClose}
          />
        </>
      )}
      {state.blockquote && state.calloutType !== null && (
        <>
          <Separator className="my-1" />
          <CalloutTypeSelector onClose={onClose} />
        </>
      )}
    </div>
  )
}
