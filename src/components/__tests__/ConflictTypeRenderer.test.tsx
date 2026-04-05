/**
 * Tests for ConflictTypeRenderer component.
 *
 * Validates type-specific rendering of conflict content:
 *  - Text conflicts show Current:/Incoming: with rich content
 *  - Property conflicts show field-by-field diffs
 *  - Move conflicts show parent/position changes
 *  - Fallback to text rendering when Property has no diffs
 *  - Expand/collapse behaviour for text conflicts
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeConflict } from '../../__tests__/fixtures'
import { ConflictTypeRenderer } from '../ConflictTypeRenderer'

vi.mock('../StaticBlock', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

const originalBlock = {
  id: 'ORIG001',
  block_type: 'content',
  content: 'original content',
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

describe('ConflictTypeRenderer', () => {
  describe('Text conflicts', () => {
    it('renders Current and Incoming labels for text conflict', () => {
      const block = makeConflict({ id: 'C1', content: 'incoming text' })

      render(
        <ConflictTypeRenderer
          conflictType="Text"
          block={block}
          original={originalBlock}
          isExpanded={false}
        />,
      )

      expect(screen.getByText('Current:')).toBeInTheDocument()
      expect(screen.getByText('Incoming:')).toBeInTheDocument()
      expect(screen.getByText('original content')).toBeInTheDocument()
      expect(screen.getByText('incoming text')).toBeInTheDocument()
    })

    it('shows fallback when original is undefined', () => {
      const block = makeConflict({ id: 'C1', content: 'incoming text' })

      render(
        <ConflictTypeRenderer
          conflictType="Text"
          block={block}
          original={undefined}
          isExpanded={false}
        />,
      )

      expect(screen.getByText('(original not available)')).toBeInTheDocument()
      expect(screen.getByText('incoming text')).toBeInTheDocument()
    })

    it('shows empty content label when block content is null', () => {
      const block = makeConflict({ id: 'C1', content: null })

      render(
        <ConflictTypeRenderer
          conflictType="Text"
          block={block}
          original={originalBlock}
          isExpanded={false}
        />,
      )

      expect(screen.getByText('(empty)')).toBeInTheDocument()
    })

    it('shows empty content label when original content is null', () => {
      const block = makeConflict({ id: 'C1', content: 'incoming' })
      const origNoContent = { ...originalBlock, content: null }

      render(
        <ConflictTypeRenderer
          conflictType="Text"
          block={block}
          original={origNoContent}
          isExpanded={false}
        />,
      )

      expect(screen.getByText('(empty)')).toBeInTheDocument()
    })

    it('applies truncate class when collapsed', () => {
      const block = makeConflict({ id: 'C1', content: 'incoming text' })

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Text"
          block={block}
          original={originalBlock}
          isExpanded={false}
        />,
      )

      const currentDiv = container.querySelector('.conflict-original')
      const incomingDiv = container.querySelector('.conflict-incoming')
      expect(currentDiv?.className).toContain('truncate')
      expect(incomingDiv?.className).toContain('truncate')
    })

    it('removes truncate class when expanded', () => {
      const block = makeConflict({ id: 'C1', content: 'incoming text' })

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Text"
          block={block}
          original={originalBlock}
          isExpanded={true}
        />,
      )

      const currentDiv = container.querySelector('.conflict-original')
      const incomingDiv = container.querySelector('.conflict-incoming')
      expect(currentDiv?.className).not.toContain('truncate')
      expect(incomingDiv?.className).not.toContain('truncate')
      expect(currentDiv?.className).toContain('max-h-40')
      expect(incomingDiv?.className).toContain('max-h-40')
    })
  })

  describe('Property conflicts', () => {
    it('renders property diff when fields differ', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'same',
        conflict_type: 'Property',
        todo_state: 'DONE',
        priority: 'A',
      })
      const original = {
        ...originalBlock,
        content: 'same',
        todo_state: 'TODO',
        priority: 'B',
      }

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Property"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      expect(container.querySelector('.conflict-property-diff')).toBeTruthy()
      expect(screen.getByText('Property changes')).toBeInTheDocument()
      expect(screen.getByText(/State:/)).toBeInTheDocument()
      expect(screen.getByText(/Priority:/)).toBeInTheDocument()
    })

    it('renders due date diff', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'same',
        conflict_type: 'Property',
        due_date: '2025-06-01',
      })
      const original = {
        ...originalBlock,
        content: 'same',
        due_date: '2025-05-01',
      }

      render(
        <ConflictTypeRenderer
          conflictType="Property"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      expect(screen.getByText(/Due:/)).toBeInTheDocument()
    })

    it('renders scheduled date diff', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'same',
        conflict_type: 'Property',
        scheduled_date: '2025-06-01',
      })
      const original = {
        ...originalBlock,
        content: 'same',
        scheduled_date: '2025-05-01',
      }

      render(
        <ConflictTypeRenderer
          conflictType="Property"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      expect(screen.getByText(/Scheduled:/)).toBeInTheDocument()
    })

    it('shows "Content also changed" when content differs', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'new content',
        conflict_type: 'Property',
        todo_state: 'DONE',
      })
      const original = {
        ...originalBlock,
        content: 'old content',
        todo_state: 'TODO',
      }

      render(
        <ConflictTypeRenderer
          conflictType="Property"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      expect(screen.getByText('Content also changed')).toBeInTheDocument()
    })

    it('falls back to text rendering when no property diffs detected', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'identical',
        conflict_type: 'Property',
        todo_state: 'TODO',
        priority: 'A',
      })
      const original = {
        ...originalBlock,
        content: 'identical',
        todo_state: 'TODO',
        priority: 'A',
      }

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Property"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      expect(container.querySelector('.conflict-property-diff')).toBeNull()
      expect(screen.getByText('Current:')).toBeInTheDocument()
      expect(screen.getByText('Incoming:')).toBeInTheDocument()
    })
  })

  describe('Move conflicts', () => {
    it('renders move diff with parent change', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'moved block',
        parent_id: 'NEW_PARENT',
        position: 3,
        conflict_type: 'Move',
      })
      const original = {
        ...originalBlock,
        parent_id: 'OLD_PARENT',
        position: 1,
      }

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Move"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      expect(container.querySelector('.conflict-move-diff')).toBeTruthy()
      expect(screen.getByText('Move conflict')).toBeInTheDocument()
      expect(screen.getByText(/Parent:/)).toBeInTheDocument()
    })

    it('renders position change', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'moved block',
        parent_id: 'SAME_PARENT',
        position: 5,
        conflict_type: 'Move',
      })
      const original = {
        ...originalBlock,
        parent_id: 'SAME_PARENT',
        position: 1,
      }

      render(
        <ConflictTypeRenderer
          conflictType="Move"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      expect(screen.getByText(/Position:/)).toBeInTheDocument()
    })

    it('falls back to text when original is undefined for Move', () => {
      const block = makeConflict({
        id: 'C1',
        content: 'moved block',
        conflict_type: 'Move',
      })

      render(
        <ConflictTypeRenderer
          conflictType="Move"
          block={block}
          original={undefined}
          isExpanded={false}
        />,
      )

      expect(screen.getByText('Current:')).toBeInTheDocument()
      expect(screen.getByText('Incoming:')).toBeInTheDocument()
    })
  })

  describe('a11y', () => {
    it('has no a11y violations for text conflict', async () => {
      const block = makeConflict({ id: 'C1', content: 'incoming text' })

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Text"
          block={block}
          original={originalBlock}
          isExpanded={false}
        />,
      )

      const results = await axe(container, {
        rules: { 'color-contrast': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations for property conflict', async () => {
      const block = makeConflict({
        id: 'C1',
        content: 'same',
        conflict_type: 'Property',
        todo_state: 'DONE',
      })
      const original = { ...originalBlock, content: 'same', todo_state: 'TODO' }

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Property"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      const results = await axe(container, {
        rules: { 'color-contrast': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations for move conflict', async () => {
      const block = makeConflict({
        id: 'C1',
        content: 'moved',
        parent_id: 'NEW_P',
        conflict_type: 'Move',
      })
      const original = { ...originalBlock, parent_id: 'OLD_P' }

      const { container } = render(
        <ConflictTypeRenderer
          conflictType="Move"
          block={block}
          original={original}
          isExpanded={false}
        />,
      )

      const results = await axe(container, {
        rules: { 'color-contrast': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })
  })
})
