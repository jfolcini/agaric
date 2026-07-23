/**
 * TurnIntoMenu — content of the always-visible toolbar's "Turn into" popover
 * (#1960). Replaces the standalone Heading / Code block / Callout / Blockquote /
 * Ordered-list / Divider toolbar buttons with one structural menu.
 *
 * Two parts:
 *  1. Turn-into list — every block-type transform (paragraph, headings 1–6,
 *     bullet / numbered list, quote, code, callout) iterated from the canonical
 *     `TURN_INTO_OPTIONS` so labels/icons never drift from the slash `/turn`
 *     family and the context-menu Turn-into group. Most rows dispatch
 *     `TURN_INTO_BLOCK` (→ `convertBlockContent` + `applyContentEdit`) and close
 *     the popover (one-shot). Divider is appended as the structural INSERT it is
 *     (`INSERT_DIVIDER` — there is no "divider" block type to convert to).
 *  2. Inline variant pickers (#3001) — the `code` and `callout` rows are
 *     DISCLOSURES, not one-shot buttons. Activating one expands its searchable
 *     picker in place (`CodeLanguageSelector` / `CalloutTypeSelector`) so the user
 *     picks the block type AND its variant (language / callout kind) in a single
 *     interaction. This replaces the old two-step flow, where turning into a code
 *     block or callout applied the default variant, closed the popover, and only
 *     surfaced the variant picker on a REOPEN. When the focused block already is a
 *     code block / callout, the matching picker starts expanded so re-picking the
 *     variant stays one interaction too.
 *
 * The pickers are rendered OUTSIDE the `role="menu"` list: their input/buttons are
 * not valid menu children (aria-required-children). Clicks use
 * `onPointerDown + preventDefault` so focus stays in the editor and the focus-keyed
 * block command bus still targets the focused block (mirrors the existing toolbar
 * popover triggers).
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { ChevronRight, Minus } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CalloutTypeSelector } from '@/components/editor-toolbar/CalloutTypeSelector'
import { CodeLanguageSelector } from '@/components/editor-toolbar/CodeLanguageSelector'
import { toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
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

/** Block-type tokens whose "turn into" row expands an inline variant picker. */
type DisclosureType = 'code' | 'callout'

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

  // #3001 — a code block / callout already under the cursor starts with its
  // variant picker expanded, so re-picking the variant is a single interaction
  // (mirrors the old auto-shown sub-picker). From any other block, the row is a
  // disclosure the user opens explicitly. Initialised once on mount; the popover
  // content remounts on each open, so it always reflects the current block.
  const [expanded, setExpanded] = useState<DisclosureType | null>(() =>
    state.codeBlock ? 'code' : state.blockquote && state.calloutType !== null ? 'callout' : null,
  )

  const disclosureFor = (blockType: string): DisclosureType | null =>
    blockType === 'code' ? 'code' : blockType === 'callout' ? 'callout' : null

  const rowClass = 'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11'

  return (
    <div className="flex flex-col gap-0.5 min-w-44">
      <div role="menu" aria-label={t('toolbar.turnInto')} className="flex flex-col gap-0.5">
        {TURN_INTO_OPTIONS.map((opt) => {
          const active = isActive(opt.blockType)
          const disclosure = disclosureFor(opt.blockType)

          if (disclosure) {
            const isOpen = expanded === disclosure
            const panelId = `turn-into-subpicker-${disclosure}`
            return (
              <Button
                key={opt.id}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                variant="ghost"
                size="sm"
                className={cn(rowClass, active && toolbarActiveClass)}
                {...toolbarPressHandlers(() =>
                  setExpanded((cur) => (cur === disclosure ? null : disclosure)),
                )}
              >
                <opt.icon className="h-3.5 w-3.5 mr-2" />
                <span>{t(turnIntoTypeKey(opt.blockType))}</span>
                <ChevronRight
                  className={cn(
                    'ml-auto h-3.5 w-3.5 shrink-0 transition-transform',
                    isOpen && 'rotate-90',
                  )}
                />
              </Button>
            )
          }

          return (
            <Button
              key={opt.id}
              role="menuitemradio"
              aria-checked={active ? 'true' : 'false'}
              variant="ghost"
              size="sm"
              className={cn(rowClass, active && toolbarActiveClass)}
              {...toolbarPressHandlers(() => {
                dispatchBlockEvent('TURN_INTO_BLOCK', { type: opt.blockType })
                onClose()
              })}
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
          {...toolbarPressHandlers(() => {
            dispatchBlockEvent('INSERT_DIVIDER')
            onClose()
          })}
        >
          <Minus className="h-3.5 w-3.5 mr-2" />
          <span>{t('toolbar.divider')}</span>
        </Button>
      </div>

      {/* Inline variant pickers — expanded in place for a single-interaction pick
          (#3001). Rendered OUTSIDE the `role="menu"` above: their input/buttons are
          not valid menu children (aria-required-children). */}
      {expanded === 'code' && (
        <div id="turn-into-subpicker-code">
          <Separator className="my-1" />
          <CodeLanguageSelector
            editor={editor}
            isCodeBlock={state.codeBlock}
            currentLanguage={state.codeLanguage}
            onClose={onClose}
          />
        </div>
      )}
      {expanded === 'callout' && (
        <div id="turn-into-subpicker-callout">
          <Separator className="my-1" />
          <CalloutTypeSelector onClose={onClose} />
        </div>
      )}
    </div>
  )
}
