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
import { useNavigationStore } from '../../stores/navigation'
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
  useNavigationStore.setState({ currentView: 'templates', pageStack: [], selectedBlockId: null })
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
    expect(state.pageStack).toEqual([{ pageId: 'T1', title: 'Meeting Notes' }])
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

    // Click the remove button
    const removeBtn = screen.getByRole('button', {
      name: /Remove template status from Meeting Notes/i,
    })
    await user.click(removeBtn)

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

    const removeBtn = screen.getByRole('button', {
      name: /remove template status/i,
    })
    await user.click(removeBtn)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to remove template status')
    })
  })
})
