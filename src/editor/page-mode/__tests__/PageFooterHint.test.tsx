import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PageFooterHint } from '@/editor/page-mode/PageFooterHint'
import { t } from '@/lib/i18n'

function renderBesideAnEditor() {
  render(
    <div>
      <div contentEditable suppressContentEditableWarning data-testid="editor">
        text
      </div>
      <PageFooterHint />
    </div>,
  )
  const editor = screen.getByTestId('editor')
  editor.focus()
  return editor
}

describe('PageFooterHint', () => {
  it('shows both halves of the hint as buttons, with no a11y violations', async () => {
    const { container } = render(<PageFooterHint />)

    expect(screen.getByRole('button', { name: t('pageMode.footerHint.markdown') })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    )
    expect(screen.getByRole('button', { name: t('pageMode.footerHint.commands') })).toBeVisible()
    expect(container).toHaveTextContent('Supports Markdown. Type / for commands')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('opens the Markdown reference, and closing it gives the focus back to the editor', async () => {
    const user = userEvent.setup()
    const editor = renderBesideAnEditor()

    await user.click(screen.getByRole('button', { name: t('pageMode.footerHint.markdown') }))
    const sheet = await screen.findByRole('dialog', { name: t('referenceSheet.markdown.title') })
    expect(sheet).toHaveAttribute('data-editor-portal')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(editor).toHaveFocus()
  })

  it('opens the command reference, and closing it gives the focus back to the editor', async () => {
    const user = userEvent.setup()
    const editor = renderBesideAnEditor()

    await user.click(screen.getByRole('button', { name: t('pageMode.footerHint.commands') }))
    await screen.findByRole('dialog', { name: t('referenceSheet.commands.title') })

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(editor).toHaveFocus()
  })
})
