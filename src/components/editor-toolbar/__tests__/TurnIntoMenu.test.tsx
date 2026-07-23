/**
 * Tests for TurnIntoMenu (#1960; single-step disclosure rework #3001).
 *
 * The picker-level single-step behaviour is covered by the CalloutTypeSelector /
 * CodeLanguageSelector suites; THIS suite pins the disclosure WIRING that makes
 * the whole flow single-step — the exact locus of the old two-step bug:
 *
 *  - From a plain paragraph the `Code block` / `Callout` rows are DISCLOSURES
 *    that expand their variant picker IN PLACE (reachable in one popover open,
 *    no reopen), not one-shot buttons that apply a default and close.
 *  - The code disclosure forwards `isCodeBlock={state.codeBlock}` — false for a
 *    paragraph — so converting paragraph → code+language happens in one shot via
 *    `toggleCodeBlockSafely` rather than `updateAttributes` on a non-existent
 *    code block. A regression to a hardcoded `isCodeBlock` would fail here.
 *  - When the focused block ALREADY is a code block / callout, the matching
 *    picker starts expanded so re-picking the variant stays one interaction.
 *  - Disclosure rows expose `aria-haspopup="dialog"` / `aria-expanded` /
 *    `aria-controls`, and the panel they open is a labelled `role="dialog"`
 *    (matching the real filter-input + option-list panel — not a `role="menu"`).
 *
 * The child pickers are replaced with prop-capturing doubles: this suite is the
 * unit boundary for the menu's own state machine, not the pickers' internals.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TurnIntoMenu } from '@/components/editor-toolbar/TurnIntoMenu'
import { t } from '@/lib/i18n'

// Controlled editor state — TurnIntoMenu's `useEditorState(selector)` is mocked
// to return this object wholesale (the selector is ignored). Each test sets the
// shape it needs before rendering.
interface MenuState {
  headingLevel: number
  blockquote: boolean
  codeBlock: boolean
  bulletList: boolean
  orderedList: boolean
  calloutType: string | null
  codeLanguage: string
}

const PARAGRAPH_STATE: MenuState = {
  headingLevel: 0,
  blockquote: false,
  codeBlock: false,
  bulletList: false,
  orderedList: false,
  calloutType: null,
  codeLanguage: '',
}

let mockEditorState: MenuState = { ...PARAGRAPH_STATE }

vi.mock('@tiptap/react', () => ({
  useEditorState: () => mockEditorState,
}))

// Prop-capturing double: record what the menu forwards to the code picker (esp.
// `isCodeBlock`) and render an identifiable marker so presence == "picker
// reachable in this open". The callout picker only needs presence, not props.
const codeSelectorProps = vi.fn()

vi.mock('@/components/editor-toolbar/CodeLanguageSelector', () => ({
  CodeLanguageSelector: (props: { isCodeBlock: boolean; currentLanguage: string }) => {
    codeSelectorProps(props)
    return <div data-testid="code-picker" data-is-code-block={String(props.isCodeBlock)} />
  },
}))

vi.mock('@/components/editor-toolbar/CalloutTypeSelector', () => ({
  CalloutTypeSelector: () => <div data-testid="callout-picker" />,
}))

function makeEditor(): Editor {
  return {} as unknown as Editor
}

function codeRow(): HTMLElement {
  return screen.getByRole('menuitem', { name: t('contextMenu.turnIntoType.code') })
}
function calloutRow(): HTMLElement {
  return screen.getByRole('menuitem', { name: t('contextMenu.turnIntoType.callout') })
}

afterEach(() => {
  vi.clearAllMocks()
  mockEditorState = { ...PARAGRAPH_STATE }
})

describe('TurnIntoMenu — single-step disclosures (#3001)', () => {
  describe('from a plain paragraph', () => {
    it('does not eagerly render either variant picker', () => {
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)
      expect(screen.queryByTestId('code-picker')).not.toBeInTheDocument()
      expect(screen.queryByTestId('callout-picker')).not.toBeInTheDocument()
    })

    it('clicking Callout expands the callout picker in place (one open, no reopen)', () => {
      const onClose = vi.fn()
      render(<TurnIntoMenu editor={makeEditor()} onClose={onClose} />)

      fireEvent.pointerDown(calloutRow(), { button: 0 })

      expect(screen.getByTestId('callout-picker')).toBeInTheDocument()
      // A disclosure toggle must NOT close the popover or apply a default.
      expect(onClose).not.toHaveBeenCalled()
    })

    it('clicking Code block expands the code picker with isCodeBlock=false (paragraph → code+language in one shot)', () => {
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      fireEvent.pointerDown(codeRow(), { button: 0 })

      const picker = screen.getByTestId('code-picker')
      expect(picker).toBeInTheDocument()
      expect(picker).toHaveAttribute('data-is-code-block', 'false')
      expect(codeSelectorProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ isCodeBlock: false }),
      )
    })

    it('toggling a disclosure a second time collapses it', () => {
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      fireEvent.pointerDown(codeRow(), { button: 0 })
      expect(screen.getByTestId('code-picker')).toBeInTheDocument()

      fireEvent.pointerDown(codeRow(), { button: 0 })
      expect(screen.queryByTestId('code-picker')).not.toBeInTheDocument()
    })

    it('opening one disclosure closes the other (only one expanded at a time)', () => {
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      fireEvent.pointerDown(codeRow(), { button: 0 })
      expect(screen.getByTestId('code-picker')).toBeInTheDocument()

      fireEvent.pointerDown(calloutRow(), { button: 0 })
      expect(screen.getByTestId('callout-picker')).toBeInTheDocument()
      expect(screen.queryByTestId('code-picker')).not.toBeInTheDocument()
    })
  })

  describe('when the focused block already has the type', () => {
    it('a code block starts with the language picker expanded and isCodeBlock=true', () => {
      mockEditorState = { ...PARAGRAPH_STATE, codeBlock: true, codeLanguage: 'rust' }
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      const picker = screen.getByTestId('code-picker')
      expect(picker).toBeInTheDocument()
      expect(picker).toHaveAttribute('data-is-code-block', 'true')
      expect(codeSelectorProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ isCodeBlock: true, currentLanguage: 'rust' }),
      )
    })

    it('a callout starts with the callout picker expanded', () => {
      mockEditorState = { ...PARAGRAPH_STATE, blockquote: true, calloutType: 'warning' }
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      expect(screen.getByTestId('callout-picker')).toBeInTheDocument()
    })

    it('a plain blockquote (no calloutType) does NOT auto-expand the callout picker', () => {
      mockEditorState = { ...PARAGRAPH_STATE, blockquote: true, calloutType: null }
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      expect(screen.queryByTestId('callout-picker')).not.toBeInTheDocument()
    })
  })

  describe('disclosure a11y', () => {
    it('exposes haspopup/expanded/controls that reflect the open state', () => {
      render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      const row = calloutRow()
      // The disclosure opens a labelled role="dialog" panel (filter input +
      // option rows), NOT a menu — so it must advertise haspopup="dialog".
      expect(row).toHaveAttribute('aria-haspopup', 'dialog')
      expect(row).toHaveAttribute('aria-expanded', 'false')
      expect(row).not.toHaveAttribute('aria-controls')

      fireEvent.pointerDown(row, { button: 0 })

      expect(calloutRow()).toHaveAttribute('aria-expanded', 'true')
      expect(calloutRow()).toHaveAttribute('aria-controls', 'turn-into-subpicker-callout')
      // The controlled panel exists with that id and is a NAMED dialog, so the
      // haspopup="dialog" advertisement matches a real, labelled dialog.
      const panel = document.getElementById('turn-into-subpicker-callout')
      expect(panel).toBeInTheDocument()
      expect(panel).toHaveAttribute('role', 'dialog')
      expect(panel).toHaveAccessibleName()
    })

    it('has no a11y violations with a disclosure expanded', async () => {
      const { container } = render(<TurnIntoMenu editor={makeEditor()} onClose={vi.fn()} />)

      fireEvent.pointerDown(calloutRow(), { button: 0 })

      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
