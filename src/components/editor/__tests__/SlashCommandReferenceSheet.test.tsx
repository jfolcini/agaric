import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { SlashCommandReferenceSheet } from '@/components/editor/SlashCommandReferenceSheet'
import { t } from '@/lib/i18n'

function renderOpen() {
  const onOpenChange = vi.fn()
  render(<SlashCommandReferenceSheet open onOpenChange={onOpenChange} />)
  return { onOpenChange, sheet: screen.getByRole('dialog') }
}

describe('SlashCommandReferenceSheet', () => {
  it('lists the commands by the menu’s categories, with no a11y violations', async () => {
    const { sheet } = renderOpen()

    const formatting = within(sheet).getByRole('region', {
      name: t('slashCommand.categories.formatting'),
    })
    expect(within(formatting).getByText('BOLD')).toBeInTheDocument()
    expect(within(formatting).getByText(t('slashCommand.description.bold'))).toBeInTheDocument()
    const structure = within(sheet).getByRole('region', {
      name: t('slashCommand.categories.structure'),
    })
    expect(within(structure).getByText('Heading 4')).toBeInTheDocument()
    expect(await axe(sheet)).toHaveNoViolations()
  })

  it('leaves out what page mode does not offer', () => {
    const { sheet } = renderOpen()

    expect(within(sheet).queryByText('DUPLICATE')).toBeNull()
    expect(within(sheet).queryByText('TEMPLATE')).toBeNull()
  })

  it('shows a command’s keyboard shortcut beside it', () => {
    const { sheet } = renderOpen()

    const bold = within(sheet).getByText('BOLD').closest('li') as HTMLElement
    expect(bold.querySelector('kbd')).not.toBeNull()
    expect(bold).toHaveTextContent('B')
    const due = within(sheet).getByText('DUE').closest('li') as HTMLElement
    expect(due.querySelector('kbd')).toBeNull()
  })

  it('filters by name or description, and says when nothing matches', async () => {
    const user = userEvent.setup()
    const { sheet } = renderOpen()
    const filter = within(sheet).getByRole('textbox', { name: t('referenceSheet.commands.filter') })

    await user.type(filter, 'struck')
    expect(within(sheet).getByText('STRIKE')).toBeInTheDocument()
    expect(within(sheet).queryByText('BOLD')).toBeNull()

    await user.clear(filter)
    await user.type(filter, 'zzzz')
    expect(
      within(sheet).getByText(t('referenceSheet.noMatches', { filter: 'zzzz' })),
    ).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderOpen()

    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
