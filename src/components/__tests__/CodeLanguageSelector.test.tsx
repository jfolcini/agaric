/**
 * Tests for CodeLanguageSelector.
 *
 * Validates:
 *  - Renders one button per language + a "Plain text" button
 *  - Current language button is highlighted
 *  - Clicking a language when NOT in a code block calls
 *    `toggleCodeBlock().updateAttributes()` (two-step: convert + set language)
 *  - Clicking a language when already in a code block calls
 *    `updateAttributes()` only (no toggle)
 *  - Clicking "Plain text" when in a code block clears the language
 *  - Clicking "Plain text" when NOT in a code block toggles a new code block
 *  - `onClose()` is invoked after each selection
 *  - Axe audit passes
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { CODE_LANGUAGES } from '@/lib/toolbar-config'
import { CodeLanguageSelector } from '../CodeLanguageSelector'

// ── TipTap editor chain mock ──────────────────────────────────────────────
// The component invokes one of three chain shapes:
//   chain().focus().toggleCodeBlock().updateAttributes('codeBlock', { language }).run()  // not-in-code-block path
//   chain().focus().updateAttributes('codeBlock', { language }).run()                    // already-in-code-block path
//   chain().focus().toggleCodeBlock().run()                                              // plain-text on non-code-block
// The mock records every link's arguments so tests can assert the exact call sequence.

const mockRun = vi.fn()
const mockUpdateAttributes = vi.fn(() => ({ run: mockRun }))
const mockToggleCodeBlock = vi.fn(() => ({
  run: mockRun,
  updateAttributes: mockUpdateAttributes,
}))
const mockFocus = vi.fn(() => ({
  toggleCodeBlock: mockToggleCodeBlock,
  updateAttributes: mockUpdateAttributes,
}))
const mockChain = vi.fn(() => ({
  focus: mockFocus,
}))

function makeEditor(): Editor {
  return { chain: mockChain } as unknown as Editor
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CodeLanguageSelector', () => {
  describe('rendering', () => {
    it('renders a button for every language in CODE_LANGUAGES plus a plain-text button', () => {
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage=""
          onClose={vi.fn()}
        />,
      )

      for (const lang of CODE_LANGUAGES) {
        expect(screen.getByRole('button', { name: lang })).toBeInTheDocument()
      }
      expect(screen.getByRole('button', { name: t('toolbar.plainText') })).toBeInTheDocument()
    })

    it('highlights the currently selected language button', () => {
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage="rust"
          onClose={vi.fn()}
        />,
      )

      // The `bg-accent` highlight is applied as a standalone class on the
      // selected button; the Button base only contains `hover:bg-accent` and
      // `dark:hover:bg-accent`, so we match on a whitespace-delimited token.
      const rustBtn = screen.getByRole('button', { name: 'rust' })
      expect(rustBtn.className).toMatch(/(^|\s)bg-accent(\s|$)/)

      const pythonBtn = screen.getByRole('button', { name: 'python' })
      expect(pythonBtn.className).not.toMatch(/(^|\s)bg-accent(\s|$)/)
    })

    it('highlights the Plain text button when in a code block with no language', () => {
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage=""
          onClose={vi.fn()}
        />,
      )

      const plainBtn = screen.getByRole('button', { name: t('toolbar.plainText') })
      expect(plainBtn.className).toMatch(/(^|\s)bg-accent(\s|$)/)
    })

    it('does NOT highlight the Plain text button outside of a code block', () => {
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={false}
          currentLanguage=""
          onClose={vi.fn()}
        />,
      )

      const plainBtn = screen.getByRole('button', { name: t('toolbar.plainText') })
      expect(plainBtn.className).not.toMatch(/(^|\s)bg-accent(\s|$)/)
    })
  })

  describe('language button behavior', () => {
    it('within a code block: clicking a language calls updateAttributes with the language only', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage=""
          onClose={onClose}
        />,
      )

      await user.click(screen.getByRole('button', { name: 'typescript' }))

      expect(mockChain).toHaveBeenCalledTimes(1)
      expect(mockFocus).toHaveBeenCalledTimes(1)
      expect(mockToggleCodeBlock).not.toHaveBeenCalled()
      expect(mockUpdateAttributes).toHaveBeenCalledTimes(1)
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'typescript' })
      expect(mockRun).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('outside a code block: clicking a language also calls toggleCodeBlock before updateAttributes', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={false}
          currentLanguage=""
          onClose={onClose}
        />,
      )

      await user.click(screen.getByRole('button', { name: 'python' }))

      expect(mockToggleCodeBlock).toHaveBeenCalledTimes(1)
      expect(mockUpdateAttributes).toHaveBeenCalledTimes(1)
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'python' })
      expect(mockRun).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)

      // toggleCodeBlock must be called BEFORE updateAttributes
      const toggleOrder = mockToggleCodeBlock.mock.invocationCallOrder[0] ?? 0
      const updateOrder = mockUpdateAttributes.mock.invocationCallOrder[0] ?? 0
      expect(toggleOrder).toBeLessThan(updateOrder)
    })
  })

  describe('plain-text button behavior', () => {
    it('within a code block: clicking Plain text clears the language via updateAttributes', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage="rust"
          onClose={onClose}
        />,
      )

      await user.click(screen.getByRole('button', { name: t('toolbar.plainText') }))

      expect(mockToggleCodeBlock).not.toHaveBeenCalled()
      expect(mockUpdateAttributes).toHaveBeenCalledTimes(1)
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: '' })
      expect(mockRun).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('outside a code block: clicking Plain text toggles a code block on', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={false}
          currentLanguage=""
          onClose={onClose}
        />,
      )

      await user.click(screen.getByRole('button', { name: t('toolbar.plainText') }))

      expect(mockToggleCodeBlock).toHaveBeenCalledTimes(1)
      expect(mockUpdateAttributes).not.toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('accessibility', () => {
    it('has no a11y violations', async () => {
      const { container } = render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage="javascript"
          onClose={vi.fn()}
        />,
      )
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
