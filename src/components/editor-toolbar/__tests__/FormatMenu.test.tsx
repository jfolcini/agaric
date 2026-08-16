/**
 * Tests for FormatMenu component.
 *
 * FormatMenu is the "Format" popover's content — reachable from the
 * always-visible toolbar WITHOUT a text selection, and (unlike
 * SelectionBubbleMenu) never gated on `useIsTouch`. It hosts only the inline
 * mark toggles (Bold/Italic/Code/Strike/Highlight/Underline).
 *
 * #3276 f3 found a real touch gap — an existing link's URL/label couldn't be
 * edited on a coarse pointer, since the only link UI lived inside
 * `SelectionBubbleMenu`, which `!isTouch` suppresses entirely. An earlier
 * version of this fix mounted the link button + `LinkEditPopover` HERE, but
 * that regressed `FormattingToolbar.test.tsx`'s pre-existing, deliberate
 * contract ("External Link still lives ONLY in the selection bubble — not in
 * the Format popover or the toolbar", #1958). The gap is closed in
 * `SelectionBubbleMenu`'s `shouldShow` instead (see
 * `SelectionBubbleMenu.test.tsx`'s "#3276 f3" describe block) — FormatMenu
 * stays mark-toggles-only.
 *
 * Validates:
 *  - Renders the 6 mark toggles, ungated by touch detection.
 *  - Does NOT render an External Link button (that stays exclusive to
 *    SelectionBubbleMenu).
 *  - onPointerDown + preventDefault preserves editor focus.
 *  - canStrike=false disables only the strikethrough toggle.
 */

import { render, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FormatMenu } from '@/components/editor-toolbar/FormatMenu'
import { t } from '@/lib/i18n'

// ── Mocks ────────────────────────────────────────────────────────────────

const mockEditorState = {
  bold: false,
  italic: false,
  code: false,
  strike: false,
  canStrike: true,
  underline: false,
  highlight: false,
}

vi.mock('@tiptap/react', () => ({
  useEditorState: () => mockEditorState,
}))

// FormatMenu must NOT consult useIsTouch at all (unlike SelectionBubbleMenu's
// `!isTouch` gate) — mocking it to `true` and asserting the mark toggles
// still render proves the popover isn't accidentally routed through the same
// suppression.
vi.mock('@/hooks/useIsTouch', () => ({
  useIsTouch: () => true,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}))

// ── Editor mock helpers ─────────────────────────────────────────────────

const mockRun = vi.fn()
const mockToggleBold = vi.fn(() => ({ run: mockRun }))
const mockFocus = vi.fn(() => ({ toggleBold: mockToggleBold }))
const mockChain = vi.fn(() => ({ focus: mockFocus }))
const mockGetAttributes = vi.fn(() => ({}))
const mockIsActive = vi.fn(() => false)
const mockCanToggleStrike = vi.fn(() => true)
const mockCan = vi.fn(() => ({ toggleStrike: mockCanToggleStrike }))

function makeEditor() {
  return {
    chain: mockChain,
    getAttributes: mockGetAttributes,
    isActive: mockIsActive,
    can: mockCan,
    state: {
      doc: { resolve: vi.fn(() => ({})), textBetween: vi.fn(() => '') },
      selection: { from: 0, to: 0 },
    },
    schema: { marks: { link: { name: 'link' } } },
  } as never
}

describe('FormatMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEditorState.bold = false
    mockEditorState.italic = false
    mockEditorState.code = false
    mockEditorState.strike = false
    mockEditorState.canStrike = true
    mockEditorState.underline = false
    mockEditorState.highlight = false
    mockGetAttributes.mockReturnValue({})
    mockIsActive.mockReturnValue(false)
    mockCanToggleStrike.mockReturnValue(true)
  })

  it('renders the 6 mark toggles reachable without a selection, ungated by touch', () => {
    render(<FormatMenu editor={makeEditor()} />)
    for (const key of [
      'toolbar.bold',
      'toolbar.italic',
      'toolbar.code',
      'toolbar.strikethrough',
      'toolbar.highlight',
      'toolbar.underline',
    ]) {
      expect(screen.getByRole('button', { name: t(key) })).toBeInTheDocument()
    }
  })

  // #3276 f3 — the touch-reachable link affordance lives in
  // SelectionBubbleMenu instead; FormatMenu must never expose it, matching
  // FormattingToolbar.test.tsx's contract.
  it('does not render an External Link button', () => {
    render(<FormatMenu editor={makeEditor()} />)
    expect(screen.queryByRole('button', { name: t('toolbar.link') })).toBeNull()
  })

  it('reflects active marks via aria-pressed', () => {
    mockEditorState.bold = true
    render(<FormatMenu editor={makeEditor()} />)
    expect(screen.getByRole('button', { name: t('toolbar.bold') })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: t('toolbar.italic') })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  // #2995 — strike is excluded from the mark set inside inline `code` /
  // `codeBlock`; the toggle greys out there instead of acting as a no-op.
  it('disables only strikethrough when canStrike is false', () => {
    mockEditorState.canStrike = false
    render(<FormatMenu editor={makeEditor()} />)
    expect(screen.getByRole('button', { name: t('toolbar.strikethrough') })).toBeDisabled()
    for (const key of ['toolbar.bold', 'toolbar.italic', 'toolbar.code', 'toolbar.highlight']) {
      expect(screen.getByRole('button', { name: t(key) })).not.toBeDisabled()
    }
  })

  it('prevents default on pointerdown to preserve editor focus', () => {
    render(<FormatMenu editor={makeEditor()} />)
    const btn = screen.getByRole('button', { name: t('toolbar.bold') })
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    const prevented = !btn.dispatchEvent(event)
    expect(prevented).toBe(true)
  })
})
