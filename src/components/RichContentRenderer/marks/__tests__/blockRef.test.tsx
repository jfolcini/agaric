/**
 * Tests for `renderBlockRef` — the `((ULID))` block-ref chip.
 *
 * #4228 — the resolve-store title is normalised ONCE at the seed
 * (`normalizeBlockRefTitle`, `@/lib/block-title`), so this renderer no
 * longer derives its own first-line/cap and simply renders the stored
 * value verbatim. These tests pin that: a block whose content begins with
 * `"\n"` (empty first line) must render a NON-BLANK chip via the stored
 * placeholder, not the pre-#4228 blank chip, while a genuinely-titled
 * block keeps rendering its real title.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import type { RenderContext } from '@/components/RichContentRenderer/context'
import { renderBlockRef } from '@/components/RichContentRenderer/marks/blockRef'
import type { BlockRefNode } from '@/editor/types'
import { normalizeBlockRefTitle } from '@/lib/block-title'
import { t } from '@/lib/i18n'

function node(id: string): BlockRefNode {
  return { type: 'block_ref', attrs: { id } }
}

function baseCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  return { interactive: true, ...overrides }
}

describe('renderBlockRef — chip label reflects the stored title verbatim', () => {
  it('renders a NON-BLANK chip for newline-leading content (empty first line)', () => {
    // Mirrors what the resolve-store seed now writes for '\nreal text'
    // (normalizeBlockRefTitle('\nreal text') === the Untitled placeholder)
    // — the chip must render that placeholder, not an empty string.
    const title = normalizeBlockRefTitle('\nreal text')

    render(<>{renderBlockRef(node('BR1'), 'k', baseCtx({ resolveBlockTitle: () => title }))}</>)

    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.textContent).toBe(title)
    expect(chip.textContent).not.toBe('')
    expect(chip.textContent).toBe(t('block.untitled'))
  })

  // Symmetric pair — a fix that always shows the placeholder is not a fix.
  it('renders the real title verbatim for a genuinely-titled block', () => {
    render(
      <>{renderBlockRef(node('BR2'), 'k', baseCtx({ resolveBlockTitle: () => 'real title' }))}</>,
    )

    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.textContent).toBe('real title')
  })

  it('falls back to the truncated-id placeholder when unresolved (no resolveBlockTitle)', () => {
    render(<>{renderBlockRef(node('01ABCDEFGH'), 'k', baseCtx())}</>)

    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.textContent).toBe('(( 01ABCDEF... ))')
  })

  it('does not re-derive a first line or re-cap — renders exactly what resolveBlockTitle returns', () => {
    // A title already normalised upstream (first line already split, already
    // capped) must pass through unchanged, even if it happens to be longer
    // than the old per-renderer 60-char cap — proves the split/cap the
    // renderer used to do locally is gone.
    const alreadyNormalised = `${'a'.repeat(80)}` // > 60 chars, on purpose
    render(
      <>
        {renderBlockRef(node('BR3'), 'k', baseCtx({ resolveBlockTitle: () => alreadyNormalised }))}
      </>,
    )
    expect(screen.getByTestId('block-ref-chip').textContent).toBe(alreadyNormalised)
  })

  /**
   * #4228 dropped the Radix `<Tooltip>` that used to wrap this chip. It
   * earned its place only while it showed something the chip did NOT — up to
   * 300 chars of raw, multi-line content against a 60-char first line. Once
   * the store holds one normalised title that both renderers render verbatim,
   * the floating tooltip would render the chip's own string back at it: a
   * portal plus a hover/focus state machine per chip, per block, for no extra
   * information. The remaining job — reveal what `max-width` clipped — is a
   * native `title=`, exactly as the sibling `renderBlockLink` does it.
   */
  it('exposes the title as a native title= attribute and no floating tooltip', async () => {
    const user = userEvent.setup()
    const title = 'shared title'
    render(<>{renderBlockRef(node('BR4'), 'k', baseCtx({ resolveBlockTitle: () => title }))}</>)
    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.textContent).toBe(title)
    expect(chip.getAttribute('title')).toBe(title)

    // No duplicated floating copy of the string the chip already shows.
    await user.hover(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  /**
   * The chip's `…` marker is a CSS concern (`.block-ref-chip-label` in
   * `src/index.css`), and happy-dom lays nothing out — but the half this
   * renderer OWNS is testable: the title has to sit in a real, addressable
   * child. `.block-ref-chip` is `inline-flex`, so a bare text child would be
   * an anonymous flex item that no selector can reach and `text-overflow`
   * cannot ellipsise. Putting the text back directly on the chip is exactly
   * the regression that made the ellipsis inert, and the CSS spelling test
   * (`@/lib/__tests__/block-ref-chip-css.test.ts`) cannot see it.
   */
  it('puts the title in a .block-ref-chip-label child, the box the ellipsis applies to', () => {
    const title = 'a title long enough that max-width would clip it on screen'
    render(<>{renderBlockRef(node('BRL'), 'k', baseCtx({ resolveBlockTitle: () => title }))}</>)

    const chip = screen.getByTestId('block-ref-chip')
    const label = chip.querySelector('.block-ref-chip-label')
    expect(label).not.toBeNull()
    expect(label?.textContent).toBe(title)
    // The chip carries no text of its own outside the label.
    expect(chip.textContent).toBe(title)
  })
})

describe('renderBlockRef — deleted status', () => {
  it('includes the (non-blank) title in the aria-label when deleted, not a bare " (deleted)"', () => {
    // #4228 — before the seed fix, newline-leading content produced an
    // empty chipLabel, so the deleted aria-label degraded to " (deleted)"
    // with no real text before it. The stored title is now non-blank, so
    // the aria-label carries it.
    const title = normalizeBlockRefTitle('\nreal text')
    render(
      <>
        {renderBlockRef(
          node('BR5'),
          'k',
          baseCtx({
            resolveBlockTitle: () => title,
            resolveBlockStatus: () => 'deleted',
          }),
        )}
      </>,
    )
    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.getAttribute('aria-label')).toBe(`${title} (deleted)`)
    expect(chip.getAttribute('aria-label')).not.toBe(' (deleted)')
  })
})

describe('renderBlockRef — interaction', () => {
  it('invokes onNavigate with the ref id when the clickable chip is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <>
        {renderBlockRef(
          node('BR6'),
          'k',
          baseCtx({ resolveBlockTitle: () => 'clickable title', onNavigate }),
        )}
      </>,
    )

    await user.click(screen.getByTestId('block-ref-chip'))
    expect(onNavigate).toHaveBeenCalledWith('BR6')
  })

  it('does not attach click affordances when not interactive', () => {
    const onNavigate = vi.fn()
    render(
      <>
        {renderBlockRef(node('BR7'), 'k', {
          resolveBlockTitle: () => 'inert title',
          onNavigate,
          interactive: false,
        })}
      </>,
    )
    const chip = screen.getByTestId('block-ref-chip')
    expect(chip).not.toHaveAttribute('role', 'link')
    expect(chip).not.toHaveAttribute('tabindex', '0')
  })
})

describe('renderBlockRef — accessibility', () => {
  it('has no axe violations for an active, clickable chip', async () => {
    const { container } = render(
      <>
        {renderBlockRef(
          node('BR8'),
          'k',
          baseCtx({ resolveBlockTitle: () => 'accessible title', onNavigate: vi.fn() }),
        )}
      </>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations for a deleted, non-interactive chip', async () => {
    const { container } = render(
      <>
        {renderBlockRef(node('BR9'), 'k', {
          resolveBlockTitle: () => 'deleted title',
          resolveBlockStatus: () => 'deleted',
        })}
      </>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
