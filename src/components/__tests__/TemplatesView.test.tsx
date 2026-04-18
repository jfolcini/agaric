/**
 * Tests for TemplatesView component.
 *
 * Validates:
 *  - Loading skeleton while fetching
 *  - Empty state when no templates
 *  - Renders template list with preview
 *  - Filters templates by search input
 *  - Navigates to template on click
 *  - Removes template status on X click
 *  - Shows journal template badge
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { selectPageStack, useNavigationStore } from '../../stores/navigation'
import { TemplatesView } from '../TemplatesView'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

function makeTemplate(id: string, content: string) {
  return {
    id,
    block_type: 'page',
    content,
    parent_id: null,
    position: null,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
  }
}

function makeChild(id: string, content: string, parentId: string) {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: parentId,
    position: null,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'templates',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
})

describe('TemplatesView', () => {
  it('renders loading skeleton while fetching', () => {
    // Never-resolving promise keeps component in loading state
    mockedInvoke.mockReturnValue(new Promise(() => {}))

    const { container } = render(<TemplatesView />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('renders empty state when no templates exist', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<TemplatesView />)

    expect(
      await screen.findByText('No templates yet. Mark a page as a template to see it here.'),
    ).toBeInTheDocument()
  })

  it('renders template list with preview', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes'), makeTemplate('T2', 'Weekly Review')],
            next_cursor: null,
            has_more: false,
          }
        }
        // journal-template query
        return emptyPage
      }
      if (cmd === 'list_blocks') {
        const params = args as { parentId: string }
        if (params.parentId === 'T1') {
          return {
            items: [makeChild('C1', 'First section of meeting notes', 'T1')],
            next_cursor: null,
            has_more: false,
          }
        }
        if (params.parentId === 'T2') {
          return {
            items: [makeChild('C2', 'Review items for the week', 'T2')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      return emptyPage
    })

    render(<TemplatesView />)

    expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()
    expect(screen.getByText('Weekly Review')).toBeInTheDocument()
    expect(screen.getByText('First section of meeting notes')).toBeInTheDocument()
    expect(screen.getByText('Review items for the week')).toBeInTheDocument()
  })

  it('filters templates by search input', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes'), makeTemplate('T2', 'Weekly Review')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') {
        return emptyPage
      }
      return emptyPage
    })

    render(<TemplatesView />)

    // Wait for templates to load
    expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()
    expect(screen.getByText('Weekly Review')).toBeInTheDocument()

    // Type in search to filter
    const searchInput = screen.getByPlaceholderText('Search templates\u2026')
    await user.type(searchInput, 'meeting')

    // Only the matching template should remain
    expect(screen.getByText('Meeting Notes')).toBeInTheDocument()
    expect(screen.queryByText('Weekly Review')).not.toBeInTheDocument()
  })

  it('navigates to template on click', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') {
        return emptyPage
      }
      return emptyPage
    })

    render(<TemplatesView />)

    const templateBtn = await screen.findByRole('button', { name: /Open template Meeting Notes/i })
    await user.click(templateBtn)

    const state = useNavigationStore.getState()
    expect(state.currentView).toBe('page-editor')
    expect(selectPageStack(state)).toEqual([{ pageId: 'T1', title: 'Meeting Notes' }])
  })

  it('removes template status on X click', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') {
        return emptyPage
      }
      if (cmd === 'delete_property') {
        return null
      }
      return emptyPage
    })

    render(<TemplatesView />)

    // Wait for the template to appear
    expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()

    // Click the remove button — opens confirmation dialog
    const removeBtn = screen.getByRole('button', {
      name: /Remove template status from Meeting Notes/i,
    })
    await user.click(removeBtn)

    // Confirm in the dialog
    const confirmBtn = await screen.findByRole('button', { name: /Confirm/i })
    await user.click(confirmBtn)

    // Template should be removed from the list
    await waitFor(() => {
      expect(screen.queryByText('Meeting Notes')).not.toBeInTheDocument()
    })

    // Verify delete_property was called
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'T1',
      key: 'template',
    })

    // Verify success toast
    expect(toast.success).toHaveBeenCalledWith('Removed template status from Meeting Notes')
  })

  describe('remove template confirmation dialog', () => {
    const setupSingleTemplate = () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'query_by_property') {
          const params = args as { key: string }
          if (params.key === 'template') {
            return {
              items: [makeTemplate('T1', 'Meeting Notes')],
              next_cursor: null,
              has_more: false,
            }
          }
          return emptyPage
        }
        if (cmd === 'list_blocks') return emptyPage
        if (cmd === 'delete_property') return null
        return emptyPage
      })
    }

    it('shows confirmation dialog when clicking remove template', async () => {
      const user = userEvent.setup()
      setupSingleTemplate()

      render(<TemplatesView />)
      expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()

      const removeBtn = screen.getByRole('button', {
        name: /Remove template status from Meeting Notes/i,
      })
      await user.click(removeBtn)

      // Dialog should appear with title and description
      expect(await screen.findByText('Remove template status')).toBeInTheDocument()
      expect(
        screen.getByText(
          /Remove template status from "Meeting Notes"\? Pages already created from this template will not be affected\./,
        ),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Confirm/i })).toBeInTheDocument()
    })

    it('removes template after confirming dialog', async () => {
      const user = userEvent.setup()
      setupSingleTemplate()

      render(<TemplatesView />)
      expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()

      const removeBtn = screen.getByRole('button', {
        name: /Remove template status from Meeting Notes/i,
      })
      await user.click(removeBtn)

      // Confirm
      const confirmBtn = await screen.findByRole('button', { name: /Confirm/i })
      await user.click(confirmBtn)

      // Template removed from list
      await waitFor(() => {
        expect(screen.queryByText('Meeting Notes')).not.toBeInTheDocument()
      })

      // delete_property was called
      expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
        blockId: 'T1',
        key: 'template',
      })
    })

    it('does not remove template when dialog is cancelled', async () => {
      const user = userEvent.setup()
      setupSingleTemplate()

      render(<TemplatesView />)
      expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()

      const removeBtn = screen.getByRole('button', {
        name: /Remove template status from Meeting Notes/i,
      })
      await user.click(removeBtn)

      // Cancel
      const cancelBtn = await screen.findByRole('button', { name: /Cancel/i })
      await user.click(cancelBtn)

      // Template should still be visible
      expect(screen.getByText('Meeting Notes')).toBeInTheDocument()

      // Dialog should be gone
      expect(screen.queryByText('Remove template status')).not.toBeInTheDocument()

      // delete_property should NOT have been called
      expect(mockedInvoke).not.toHaveBeenCalledWith('delete_property', expect.anything())
    })
  })

  it('shows journal template badge', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes'), makeTemplate('T2', 'Daily Journal')],
            next_cursor: null,
            has_more: false,
          }
        }
        if (params.key === 'journal-template') {
          return {
            items: [makeTemplate('T2', 'Daily Journal')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') {
        return emptyPage
      }
      return emptyPage
    })

    render(<TemplatesView />)

    // Wait for templates to load
    expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()

    // Journal template badge should appear for T2
    expect(screen.getByText('Journal template')).toBeInTheDocument()
  })

  it('shows tooltip on journal template badge hover', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Daily Journal')],
            next_cursor: null,
            has_more: false,
          }
        }
        if (params.key === 'journal-template') {
          return {
            items: [makeTemplate('T1', 'Daily Journal')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') {
        return emptyPage
      }
      return emptyPage
    })

    render(<TemplatesView />)

    // Wait for the journal badge to appear
    const badge = await screen.findByText('Journal template')
    await user.hover(badge)

    // Tooltip text should appear (Radix renders it in multiple DOM nodes)
    await waitFor(() => {
      const tooltipElements = screen.getAllByText(
        'This template is automatically applied when creating new journal entries',
      )
      expect(tooltipElements.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<TemplatesView />)

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with templates loaded', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') {
        return {
          items: [makeChild('C1', 'First child preview', 'T1')],
          next_cursor: null,
          has_more: false,
        }
      }
      return emptyPage
    })

    render(<TemplatesView />)

    // Wait for templates to render
    await screen.findByText('Meeting Notes')

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('shows "no results" message when search filters out all templates', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') return emptyPage
      return emptyPage
    })

    render(<TemplatesView />)
    expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()

    const searchInput = screen.getByPlaceholderText('Search templates\u2026')
    await user.type(searchInput, 'zzzzz')

    expect(screen.queryByText('Meeting Notes')).not.toBeInTheDocument()
    expect(screen.getByText('No templates match your search.')).toBeInTheDocument()
  })

  it('shows error toast when loading templates fails', async () => {
    const mockedToastError = vi.mocked(toast.error)
    mockedInvoke.mockRejectedValue(new Error('network'))

    render(<TemplatesView />)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to load templates')
    })
  })

  it('shows error toast when removing template status fails', async () => {
    const user = userEvent.setup()
    const mockedToastError = vi.mocked(toast.error)
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'query_by_property') {
        const params = args as { key: string }
        if (params.key === 'template') {
          return {
            items: [makeTemplate('T1', 'Meeting Notes')],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      }
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'delete_property') throw new Error('fail')
      return emptyPage
    })

    render(<TemplatesView />)
    expect(await screen.findByText('Meeting Notes')).toBeInTheDocument()

    // Open dialog
    const removeBtn = screen.getByRole('button', {
      name: /remove template status/i,
    })
    await user.click(removeBtn)

    // Confirm in the dialog
    const confirmBtn = await screen.findByRole('button', { name: /Confirm/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to remove template status')
    })
  })

  // ── UX-204: create template form ───────────────────────────────────

  describe('create template form', () => {
    it('renders input and Create button', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)
      render(<TemplatesView />)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New template name...')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /create template/i })).toBeInTheDocument()
    })

    it('disables Create button when input is empty', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)
      render(<TemplatesView />)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New template name...')).toBeInTheDocument()
      })
      const createBtn = screen.getByRole('button', { name: /create template/i })
      expect(createBtn).toBeDisabled()
    })

    it('disables Create button when input is whitespace only', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)
      render(<TemplatesView />)

      const input = await screen.findByPlaceholderText('New template name...')
      await user.type(input, '   ')

      const createBtn = screen.getByRole('button', { name: /create template/i })
      expect(createBtn).toBeDisabled()
    })

    it('valid submit calls createBlock then setProperty with template=true', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'query_by_property') return emptyPage
        if (cmd === 'list_blocks') return emptyPage
        if (cmd === 'create_block') {
          return {
            id: 'T_NEW',
            block_type: 'page',
            content: (args as { content: string }).content,
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        if (cmd === 'set_property') {
          return {
            id: 'T_NEW',
            block_type: 'page',
            content: 'My Template',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        return emptyPage
      })

      render(<TemplatesView />)

      const input = await screen.findByPlaceholderText('New template name...')
      await user.type(input, 'My Template')

      const createBtn = screen.getByRole('button', { name: /create template/i })
      await user.click(createBtn)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: 'My Template',
          parentId: null,
          position: null,
        })
      })

      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'T_NEW',
        key: 'template',
        valueText: 'true',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    it('resets input after successful creation', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_by_property') return emptyPage
        if (cmd === 'list_blocks') return emptyPage
        if (cmd === 'create_block') {
          return {
            id: 'T_NEW',
            block_type: 'page',
            content: 'My Template',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        if (cmd === 'set_property') {
          return {
            id: 'T_NEW',
            block_type: 'page',
            content: 'My Template',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        return emptyPage
      })

      render(<TemplatesView />)

      const input = (await screen.findByPlaceholderText('New template name...')) as HTMLInputElement
      await user.type(input, 'My Template')
      expect(input.value).toBe('My Template')

      const createBtn = screen.getByRole('button', { name: /create template/i })
      await user.click(createBtn)

      await waitFor(() => {
        expect(input.value).toBe('')
      })
    })

    it('adds newly-created template to the list optimistically', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_by_property') return emptyPage
        if (cmd === 'list_blocks') return emptyPage
        if (cmd === 'create_block') {
          return {
            id: 'T_NEW',
            block_type: 'page',
            content: 'My Template',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        if (cmd === 'set_property') {
          return {
            id: 'T_NEW',
            block_type: 'page',
            content: 'My Template',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        return emptyPage
      })

      render(<TemplatesView />)

      const input = await screen.findByPlaceholderText('New template name...')
      await user.type(input, 'My Template')
      await user.click(screen.getByRole('button', { name: /create template/i }))

      expect(await screen.findByText('My Template')).toBeInTheDocument()
    })

    it('shows error toast and preserves input when createBlock fails', async () => {
      const user = userEvent.setup()
      const mockedToastError = vi.mocked(toast.error)
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_by_property') return emptyPage
        if (cmd === 'list_blocks') return emptyPage
        if (cmd === 'create_block') throw new Error('backend fail')
        return emptyPage
      })

      render(<TemplatesView />)

      const input = (await screen.findByPlaceholderText('New template name...')) as HTMLInputElement
      await user.type(input, 'My Template')
      await user.click(screen.getByRole('button', { name: /create template/i }))

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith('Failed to create template')
      })
      // Input preserved on error
      expect(input.value).toBe('My Template')
    })

    it('shows error toast and preserves input when setProperty fails', async () => {
      const user = userEvent.setup()
      const mockedToastError = vi.mocked(toast.error)
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'query_by_property') return emptyPage
        if (cmd === 'list_blocks') return emptyPage
        if (cmd === 'create_block') {
          return {
            id: 'T_NEW',
            block_type: 'page',
            content: 'My Template',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        if (cmd === 'set_property') throw new Error('property fail')
        return emptyPage
      })

      render(<TemplatesView />)

      const input = (await screen.findByPlaceholderText('New template name...')) as HTMLInputElement
      await user.type(input, 'My Template')
      await user.click(screen.getByRole('button', { name: /create template/i }))

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith('Failed to create template')
      })
      // Input preserved on error (setProperty failure)
      expect(input.value).toBe('My Template')
    })
  })
})
