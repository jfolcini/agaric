/**
 * Callout types, aliases and fold markers in the static renderer (#6033):
 * every Obsidian, GitHub and GitLab type renders in the nearest of the five
 * `CALLOUT_CONFIG` styles with its stored type untouched, and a `-` / `+`
 * fold marker gives the callout a toggle that is view state only.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { clearRichContentParseCache, renderRichContent } from '@/components/RichContentRenderer'
import { CALLOUT_CONFIG } from '@/components/RichContentRenderer/context'
import { t } from '@/lib/i18n'

beforeEach(() => {
  clearRichContentParseCache()
})

const STYLE_OF: ReadonlyArray<readonly [string, string]> = [
  // Obsidian
  ['note', 'note'],
  ['abstract', 'info'],
  ['summary', 'info'],
  ['tldr', 'info'],
  ['info', 'info'],
  ['todo', 'info'],
  ['tip', 'tip'],
  ['hint', 'tip'],
  ['important', 'tip'],
  ['success', 'tip'],
  ['check', 'tip'],
  ['done', 'tip'],
  ['question', 'warning'],
  ['help', 'warning'],
  ['faq', 'warning'],
  ['warning', 'warning'],
  ['caution', 'warning'],
  ['attention', 'warning'],
  ['failure', 'error'],
  ['fail', 'error'],
  ['missing', 'error'],
  ['danger', 'error'],
  ['error', 'error'],
  ['bug', 'error'],
  ['example', 'info'],
  ['quote', 'note'],
  ['cite', 'note'],
  // GitHub and GitLab alerts, written upper case
  ['NOTE', 'note'],
  ['TIP', 'tip'],
  ['IMPORTANT', 'tip'],
  ['WARNING', 'warning'],
  ['CAUTION', 'warning'],
  // Custom types, hyphenated or not
  ['my-type', 'note'],
  ['constructor', 'note'],
]

describe('callout type → style', () => {
  it.each(STYLE_OF)('[!%s] renders in the %s style', async (type, style) => {
    const { container } = render(<>{renderRichContent(`> [!${type}] body`, {})}</>)
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', type.toLowerCase())
    expect(callout.className).toContain(CALLOUT_CONFIG[style]?.borderClass)
    expect(callout).toHaveTextContent(t(`callout.${style}`))
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('callout fold markers', () => {
  it('a callout without a fold marker has no toggle', () => {
    render(<>{renderRichContent('> [!faq] Why?\n> Because.', {})}</>)
    expect(screen.queryByTestId('callout-fold-toggle')).toBeNull()
    expect(screen.getByTestId('callout-block')).toHaveTextContent('Because.')
  })

  it('`-` starts closed on the title alone, and the toggle opens it', async () => {
    const user = userEvent.setup()
    const { container } = render(<>{renderRichContent('> [!faq]- Why?\n> Because.', {})}</>)
    const callout = screen.getByTestId('callout-block')
    const toggle = screen.getByRole('button', {
      name: t('callout.expand', { name: t('callout.warning') }),
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(callout).toHaveTextContent('Why?')
    expect(callout).not.toHaveTextContent('Because.')
    expect(await axe(container)).toHaveNoViolations()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName(t('callout.collapse', { name: t('callout.warning') }))
    expect(callout).toHaveTextContent('Because.')
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('`+` starts open, and the toggle closes it', async () => {
    const user = userEvent.setup()
    render(<>{renderRichContent('> [!my-type]+ Title\n>\n> Body', {})}</>)
    const callout = screen.getByTestId('callout-block')
    const toggle = screen.getByTestId('callout-fold-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(callout).toHaveTextContent('Body')

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(callout).toHaveTextContent('Title')
    expect(callout).not.toHaveTextContent('Body')
  })

  it('the toggle acts on the callout alone, never on the row around it', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onRowKey = vi.fn()
    render(
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- stands in for a row's click and key handlers
      <div onClick={onRowClick} onKeyDown={onRowKey}>
        {renderRichContent('> [!faq]- Why?\n> Because.', {})}
      </div>,
    )
    const toggle = screen.getByTestId('callout-fold-toggle')

    await user.click(toggle)
    toggle.focus()
    await user.keyboard('{Enter}')

    expect(onRowClick).not.toHaveBeenCalled()
    expect(onRowKey).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})
