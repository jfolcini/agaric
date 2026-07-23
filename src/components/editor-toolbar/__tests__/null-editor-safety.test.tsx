/**
 * Null-editor safety tests (#3056).
 *
 * `FormattingToolbar`, `FormatMenu`, and `TurnIntoMenu` each read editor state
 * through a `useEditorState` selector that calls `.isActive()` / `.can()` on
 * `ctx.editor`. TipTap's `useEditorState` types `ctx.editor` as non-null when
 * the `editor` prop itself is typed non-null, but at runtime the internal
 * `EditorStateManager` snapshot can carry `editor: null` — e.g. during the
 * mount/teardown race described in #3056, where `EditorSurface` renders these
 * components from a value that is only *assumed* live (`ed = editor as
 * Editor`) but is momentarily `null` while the underlying TipTap instance is
 * being destroyed. Before the fix, the very first `ctx.editor.can()` /
 * `ctx.editor.isActive()` call threw `TypeError: Cannot read properties of
 * null (reading 'can')`.
 *
 * These tests exercise the REAL `@tiptap/react` `useEditorState` hook (not
 * mocked) and pass a literal `null` editor to reproduce that race directly:
 * every one of these three components has no OTHER direct (non-selector)
 * access to the `editor` prop during render — `createMarkToggles` /
 * `createRefsAndBlocks` / `createHistoryButtons` only capture `editor` inside
 * click-handler closures — so a literal `null` prop is a faithful repro.
 * (`SelectionBubbleMenu` is covered separately in
 * `SelectionBubbleMenu-null-editor.test.tsx`: it also dereferences the raw
 * `editor` prop directly in a mount effect — `editor.view?.dom` — which is a
 * pre-existing, separate null-safety gap outside this fix's scope.)
 */

import { render, screen } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { FormatMenu } from '@/components/editor-toolbar/FormatMenu'
import { TurnIntoMenu } from '@/components/editor-toolbar/TurnIntoMenu'
import { FormattingToolbar } from '@/components/FormattingToolbar'
import { t } from '@/lib/i18n'

// Mock Separator — Radix UI Separator needs browser APIs, and it renders
// unconditionally as a group divider (unrelated to the null-editor path
// under test). Mirrors the existing FormattingToolbar/SelectionBubbleMenu
// test mocks.
vi.mock('@/components/ui/separator', () => ({
  Separator: ({ orientation, className }: { orientation?: string; className?: string }) => (
    <div data-testid="separator" data-orientation={orientation} className={className} />
  ),
}))

describe('#3056 — null-editor safety', () => {
  describe('FormattingToolbar', () => {
    it('renders without throwing when editor is null (mount/teardown race)', () => {
      expect(() => {
        render(
          <FormattingToolbar
            editor={null as unknown as React.ComponentProps<typeof FormattingToolbar>['editor']}
          />,
        )
      }).not.toThrow()
    })

    it('falls back to safe defaults: Undo/Redo disabled, no active states', () => {
      render(
        <FormattingToolbar
          editor={null as unknown as React.ComponentProps<typeof FormattingToolbar>['editor']}
        />,
      )
      expect(screen.getByRole('button', { name: t('toolbar.undo') })).toBeDisabled()
      expect(screen.getByRole('button', { name: t('toolbar.redo') })).toBeDisabled()
      // Contextual table-ops trigger is driven by `isInsideTable`, which
      // defaults to false — it must not appear.
      expect(screen.queryByRole('button', { name: t('toolbar.tableOps') })).not.toBeInTheDocument()
    })

    it('passes axe audit with a null editor', async () => {
      const { container } = render(
        <FormattingToolbar
          editor={null as unknown as React.ComponentProps<typeof FormattingToolbar>['editor']}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  describe('FormatMenu', () => {
    it('renders without throwing when editor is null', () => {
      expect(() => {
        render(
          <FormatMenu
            editor={null as unknown as React.ComponentProps<typeof FormatMenu>['editor']}
          />,
        )
      }).not.toThrow()
    })

    it('falls back to safe defaults: no active marks, Strike disabled (canStrike defaults false)', () => {
      render(
        <FormatMenu
          editor={null as unknown as React.ComponentProps<typeof FormatMenu>['editor']}
        />,
      )
      for (const key of [
        'toolbar.bold',
        'toolbar.italic',
        'toolbar.code',
        'toolbar.highlight',
        'toolbar.underline',
      ]) {
        const btn = screen.getByRole('button', { name: t(key) })
        expect(btn).toHaveAttribute('aria-pressed', 'false')
      }
      // #2995's disabledWhenFalse guard reads `canStrike`, which the null
      // branch defaults to `false` — the button greys out rather than
      // rendering as a no-op toggle.
      expect(screen.getByRole('button', { name: t('toolbar.strikethrough') })).toBeDisabled()
    })

    it('passes axe audit with a null editor', async () => {
      const { container } = render(
        <FormatMenu
          editor={null as unknown as React.ComponentProps<typeof FormatMenu>['editor']}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  describe('TurnIntoMenu', () => {
    it('renders without throwing when editor is null', () => {
      expect(() => {
        render(
          <TurnIntoMenu
            editor={null as unknown as React.ComponentProps<typeof TurnIntoMenu>['editor']}
            onClose={vi.fn()}
          />,
        )
      }).not.toThrow()
    })

    it('falls back to safe defaults: paragraph marked active, no code/callout sub-picker', () => {
      render(
        <TurnIntoMenu
          editor={null as unknown as React.ComponentProps<typeof TurnIntoMenu>['editor']}
          onClose={vi.fn()}
        />,
      )
      // All block-type flags default false / headingLevel 0 → "paragraph" is
      // the only entry that reads as active.
      expect(
        screen.getByRole('menuitemradio', { name: t('contextMenu.turnIntoType.paragraph') }),
      ).toHaveAttribute('aria-checked', 'true')
      expect(
        screen.getByRole('menuitemradio', { name: t('contextMenu.turnIntoType.h2') }),
      ).toHaveAttribute('aria-checked', 'false')
      // `codeBlock`/`blockquote` default false → the contextual sub-pickers
      // (which are NOT null-safe themselves) never mount.
      expect(screen.queryByTestId('separator')).not.toBeInTheDocument()
    })

    it('passes axe audit with a null editor', async () => {
      const { container } = render(
        <TurnIntoMenu
          editor={null as unknown as React.ComponentProps<typeof TurnIntoMenu>['editor']}
          onClose={vi.fn()}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
