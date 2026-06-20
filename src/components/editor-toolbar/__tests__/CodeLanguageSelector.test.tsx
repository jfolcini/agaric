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

import { CodeLanguageSelector } from '@/components/editor-toolbar/CodeLanguageSelector'
import { t } from '@/lib/i18n'
import { CODE_LANGUAGES } from '@/lib/toolbar-config'

// ── TipTap editor chain mock ──────────────────────────────────────────────
// The component invokes one of two paths:
//   already-in-code-block: chain().focus().updateAttributes('codeBlock', { lang }).run()
//   not-in-code-block:     toggleCodeBlockSafely(editor) + chain().focus().updateAttributes(...)
//                          where `toggleCodeBlockSafely` runs
//                          chain().focus().toggleCodeBlock(attrs).focus('end').run()
// The mock records every link's arguments so tests can assert the exact call sequence.
// `mockFocus` returns itself so the second `.focus('end')` after `toggleCodeBlock`
// resolves (the chain reuses the same focus surface to keep the mock graph flat).

const mockRun = vi.fn()
const mockUpdateAttributes = vi.fn(() => ({ run: mockRun }))
const mockToggleCodeBlock = vi.fn(() => ({
  run: mockRun,
  updateAttributes: mockUpdateAttributes,
  // `.focus(...)` is what `toggleCodeBlockSafely` appends after the
  // toggle to land the cursor inside the new node.
  focus: (..._args: unknown[]) => ({ run: mockRun }),
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

    // Per-option coverage (#1170): assert that EACH built-in language, when
    // clicked inside a code block, drives `updateAttributes('codeBlock', { language })`
    // with that exact language — not just one representative entry.
    it.each([...CODE_LANGUAGES])(
      'within a code block: clicking %s sets that language via updateAttributes',
      async (lang) => {
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

        await user.click(screen.getByRole('button', { name: lang }))

        expect(mockToggleCodeBlock).not.toHaveBeenCalled()
        expect(mockUpdateAttributes).toHaveBeenCalledTimes(1)
        expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: lang })
        expect(mockRun).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
      },
    )

    // Per-option coverage (#1170): the same set, but starting OUTSIDE a code
    // block, must route through `toggleCodeBlockSafely(editor, { language })` so
    // the language is set as part of the single toggle chain.
    it.each([...CODE_LANGUAGES])(
      'outside a code block: clicking %s toggles a code block carrying that language',
      async (lang) => {
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

        await user.click(screen.getByRole('button', { name: lang }))

        expect(mockToggleCodeBlock).toHaveBeenCalledTimes(1)
        expect(mockToggleCodeBlock).toHaveBeenCalledWith({ language: lang })
        expect(mockUpdateAttributes).not.toHaveBeenCalled()
        expect(mockRun).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
      },
    )

    it('outside a code block: clicking a language calls toggleCodeBlock with the language attrs (single chain via toggleCodeBlockSafely)', async () => {
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

      // toggleCodeBlockSafely(editor, { language: 'python' }) runs a
      // single chain: focus → toggleCodeBlock(attrs) → focus('end') → run.
      // The language is set as part of the toggle, so updateAttributes
      // is not called separately.
      expect(mockToggleCodeBlock).toHaveBeenCalledTimes(1)
      expect(mockToggleCodeBlock).toHaveBeenCalledWith({ language: 'python' })
      expect(mockUpdateAttributes).not.toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
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

  describe('filter input', () => {
    it('auto-focuses the filter input on open', () => {
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage=""
          onClose={vi.fn()}
        />,
      )

      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      expect(filter).toHaveFocus()
    })

    it('narrows the language list as the user types', async () => {
      const user = userEvent.setup()
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage=""
          onClose={vi.fn()}
        />,
      )

      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      await user.type(filter, 'rust')

      // The filter is exact enough that only `rust` survives.
      expect(screen.getByRole('button', { name: 'rust' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'python' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'typescript' })).not.toBeInTheDocument()
      // Plain text always remains, regardless of filter.
      expect(screen.getByRole('button', { name: t('toolbar.plainText') })).toBeInTheDocument()
    })

    it('Enter on the filter input selects the focused language from the filtered subset', async () => {
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

      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      // Type a query that narrows to exactly one item, then Enter.
      // Reset to focusedIndex 0 happens automatically when the filtered
      // itemCount changes — so index 0 is `rust`.
      await user.type(filter, 'rust{Enter}')

      expect(mockUpdateAttributes).toHaveBeenCalledTimes(1)
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'rust' })
      expect(mockRun).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('ArrowDown moves the highlight, Enter selects the new focused language', async () => {
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

      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      // No filter typed — full list is in play; index 0 is `javascript`,
      // index 1 is `typescript`. ArrowDown → typescript, Enter selects.
      await user.type(filter, '{ArrowDown}{Enter}')

      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'typescript' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('custom language input (#215 P2-10)', () => {
    it('offers a "Use «typed»" row + no-match hint when nothing matches', async () => {
      const user = userEvent.setup()
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage=""
          onClose={vi.fn()}
        />,
      )
      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      await user.type(filter, 'elixir')

      expect(screen.getByTestId('no-language-match')).toBeInTheDocument()
      expect(screen.getByTestId('use-custom-language')).toBeInTheDocument()
      // No built-in language button survives the non-matching filter.
      expect(screen.queryByRole('button', { name: 'rust' })).not.toBeInTheDocument()
    })

    it('does NOT offer the custom row when a built-in language matches', async () => {
      const user = userEvent.setup()
      render(
        <CodeLanguageSelector
          editor={makeEditor()}
          isCodeBlock={true}
          currentLanguage=""
          onClose={vi.fn()}
        />,
      )
      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      await user.type(filter, 'rust')
      expect(screen.queryByTestId('use-custom-language')).not.toBeInTheDocument()
    })

    it('applies the raw typed language (lower-cased, trimmed) when in a code block', async () => {
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
      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      await user.type(filter, '  Kotlin ')
      await user.pointer({
        keys: '[MouseLeft>]',
        target: screen.getByTestId('use-custom-language'),
      })

      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'kotlin' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Enter applies the custom language when no built-in matches', async () => {
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
      const filter = screen.getByRole('textbox', { name: t('toolbar.codeBlockLanguage') })
      await user.type(filter, 'swift{Enter}')
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'swift' })
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
