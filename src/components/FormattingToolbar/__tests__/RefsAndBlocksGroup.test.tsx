/**
 * Tests for `FormattingToolbar/RefsAndBlocksGroup` — the popover-trigger
 * renderers (Format / Turn into / Table ops / Insert table).
 *
 * Pins two contracts against REAL Radix popovers (no popover mock):
 *  1. Trigger activation: keyboard Enter/Space (click with `detail === 0`)
 *     toggles the popover; right/middle-click pointerdown is inert.
 *  2. Focus preservation: the popovers must not auto-focus their content on
 *     open, and Escape-dismiss must not strand DOM focus outside the editor —
 *     the same #1958 guards the Format popover carries. These popovers anchor
 *     to a `PopoverAnchor` (no `PopoverTrigger`), so Radix's default
 *     onCloseAutoFocus would drop focus onto `document.body`.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import {
  renderFormatButton,
  renderTablePickerButton,
  renderTableOpsButton,
  renderTurnIntoButton,
} from '../RefsAndBlocksGroup'

// Heavy popover children are irrelevant here — replace each with a single
// tabbable button so Radix's autofocus has a target to (wrongly) grab.
vi.mock('@/components/editor-toolbar/FormatMenu', () => ({
  FormatMenu: () => (
    <button type="button" data-testid="format-menu-item">
      format
    </button>
  ),
}))
vi.mock('@/components/editor-toolbar/TurnIntoMenu', () => ({
  TurnIntoMenu: () => (
    <button type="button" data-testid="turn-into-menu-item">
      turn
    </button>
  ),
}))
vi.mock('@/components/TableOpsSelector', () => ({
  TableOpsSelector: () => (
    <button type="button" data-testid="table-ops-item">
      ops
    </button>
  ),
}))
vi.mock('@/components/editor-toolbar/TablePicker', () => ({
  TablePicker: () => (
    <button type="button" data-testid="table-picker-item">
      pick
    </button>
  ),
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}))

const editor = {} as Editor

type Renderer = (props: {
  editor: Editor
  mode: 'inline'
  t: (key: string) => string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  onOverflowClose: () => void
}) => React.ReactElement

/**
 * Controlled harness: an editor-stand-in input plus the popover trigger under
 * test, so open/close cycles run against real Radix focus management.
 */
function Harness({
  renderButton,
  initialOpen = false,
}: {
  renderButton: Renderer
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <div>
      <input data-testid="editor-stand-in" aria-label="editor" />
      {renderButton({ editor, mode: 'inline', t, open, setOpen, onOverflowClose: vi.fn() })}
    </div>
  )
}

interface Surface {
  name: string
  renderButton: Renderer
  triggerLabel: string
  contentTestId: string
}

const surfaces: Surface[] = [
  {
    name: 'Turn into',
    renderButton: (props) => renderTurnIntoButton(props),
    triggerLabel: 'toolbar.turnInto',
    contentTestId: 'turn-into-menu-item',
  },
  {
    name: 'Table ops',
    renderButton: (props) => renderTableOpsButton(props),
    triggerLabel: 'toolbar.tableOps',
    contentTestId: 'table-ops-item',
  },
  {
    name: 'Insert table',
    renderButton: (props) => renderTablePickerButton(props),
    triggerLabel: 'toolbar.insertTable',
    contentTestId: 'table-picker-item',
  },
  {
    name: 'Format',
    renderButton: (props) => renderFormatButton(props),
    triggerLabel: 'toolbar.format',
    contentTestId: 'format-menu-item',
  },
]

describe('RefsAndBlocksGroup popover triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe.each(surfaces)(
    '$name trigger activation',
    ({ renderButton, triggerLabel, contentTestId }) => {
      it('opens the popover on a keyboard-generated click (detail === 0)', async () => {
        render(<Harness renderButton={renderButton} />)
        const trigger = screen.getByRole('button', { name: t(triggerLabel) })
        fireEvent.click(trigger, { detail: 0 })
        expect(await screen.findByTestId(contentTestId)).toBeInTheDocument()
      })

      it('ignores right-click and middle-click pointerdown', () => {
        render(<Harness renderButton={renderButton} />)
        const trigger = screen.getByRole('button', { name: t(triggerLabel) })
        fireEvent.pointerDown(trigger, { button: 2 })
        fireEvent.pointerDown(trigger, { button: 1 })
        expect(screen.queryByTestId(contentTestId)).not.toBeInTheDocument()
      })

      it('toggles on primary pointerdown without double-firing through the trailing click', () => {
        render(<Harness renderButton={renderButton} />)
        const trigger = screen.getByRole('button', { name: t(triggerLabel) })
        fireEvent.pointerDown(trigger, { button: 0 })
        // The browser still delivers a click after pointerdown — the popover
        // must stay open (not toggle shut again).
        fireEvent.click(trigger, { detail: 1 })
        expect(screen.getByTestId(contentTestId)).toBeInTheDocument()
      })
    },
  )

  describe.each(surfaces)(
    '$name focus preservation (#1958 guards)',
    ({ renderButton, triggerLabel, contentTestId }) => {
      it('does not steal DOM focus from the editor on open', async () => {
        render(<Harness renderButton={renderButton} />)
        const editorStandIn = screen.getByTestId('editor-stand-in')
        act(() => {
          editorStandIn.focus()
        })
        const trigger = screen.getByRole('button', { name: t(triggerLabel) })
        fireEvent.pointerDown(trigger, { button: 0 })
        expect(await screen.findByTestId(contentTestId)).toBeInTheDocument()
        // Radix's default onOpenAutoFocus would move focus into the popover.
        expect(document.activeElement).toBe(editorStandIn)
      })

      it('does not strand focus on <body> after Escape-dismiss', async () => {
        render(<Harness renderButton={renderButton} />)
        const editorStandIn = screen.getByTestId('editor-stand-in')
        act(() => {
          editorStandIn.focus()
        })
        fireEvent.pointerDown(screen.getByRole('button', { name: t(triggerLabel) }), { button: 0 })
        expect(await screen.findByTestId(contentTestId)).toBeInTheDocument()
        fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
        await waitFor(() => {
          expect(screen.queryByTestId(contentTestId)).not.toBeInTheDocument()
        })
        // Radix's default onCloseAutoFocus has no trigger to restore to (these
        // popovers use PopoverAnchor), so without the guard focus lands on body.
        expect(document.activeElement).toBe(editorStandIn)
      })
    },
  )

  it('has no a11y violations with the Turn into popover open', async () => {
    const { container } = render(
      <Harness renderButton={(props) => renderTurnIntoButton(props)} initialOpen />,
    )
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
