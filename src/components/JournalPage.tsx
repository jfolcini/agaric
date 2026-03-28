/**
 * JournalPage — daily journal with block creation and deletion.
 *
 * Each date MAY have a backing page block (blockType='page', content=dateString).
 * The page is invisible to the user — they just see child blocks.
 * Adding the first block auto-creates the daily page; deleting the last
 * block auto-deletes it.
 */

import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BlockRow } from '../lib/tauri'
import { createBlock, deleteBlock, listBlocks } from '../lib/tauri'

/** Format a Date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Format a Date as a readable string (e.g., "Mon, Jan 15 2025"). */
function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

interface JournalPageProps {
  /** Called when a block is clicked — navigates to block editor. */
  onBlockClick?: (blockId: string) => void
}

export function JournalPage({ onBlockClick: _onBlockClick }: JournalPageProps): React.ReactElement {
  const [date, setDate] = useState(() => new Date())
  const [dailyPageId, setDailyPageId] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [newContent, setNewContent] = useState('')

  const dateStr = formatDate(date)

  const loadBlocks = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      const page = resp.items.find((b) => b.content === formatDate(date))
      if (page) {
        setDailyPageId(page.id)
        const children = await listBlocks({ parentId: page.id })
        setBlocks(children.items)
      } else {
        setDailyPageId(null)
        setBlocks([])
      }
    } catch {
      setDailyPageId(null)
      setBlocks([])
    }
    setLoading(false)
  }, [date])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset and reload when date changes
  useEffect(() => {
    setDailyPageId(null)
    setBlocks([])
    loadBlocks()
  }, [dateStr])

  const goToPrevDay = useCallback(() => {
    setDate((prev) => {
      const d = new Date(prev)
      d.setDate(d.getDate() - 1)
      return d
    })
  }, [])

  const goToNextDay = useCallback(() => {
    setDate((prev) => {
      const d = new Date(prev)
      d.setDate(d.getDate() + 1)
      return d
    })
  }, [])

  const goToToday = useCallback(() => {
    setDate(new Date())
  }, [])

  const isToday = formatDate(new Date()) === dateStr

  async function handleAddBlock() {
    const content = newContent.trim()
    if (!content) return

    let pageId = dailyPageId
    // Auto-create daily page if it doesn't exist
    if (!pageId) {
      const page = await createBlock({ blockType: 'page', content: formatDate(date) })
      pageId = page.id
      setDailyPageId(pageId)
    }

    // Create child block
    const block = await createBlock({
      blockType: 'text',
      content,
      parentId: pageId,
      position: blocks.length,
    })

    // Add to local state
    setBlocks((prev) => [
      ...prev,
      {
        id: block.id,
        block_type: block.block_type,
        content: block.content,
        parent_id: block.parent_id,
        position: block.position,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
      },
    ])
    setNewContent('')
  }

  async function handleDeleteBlock(blockId: string) {
    await deleteBlock(blockId)
    const remaining = blocks.filter((b) => b.id !== blockId)
    setBlocks(remaining)

    // Auto-delete empty daily page
    if (remaining.length === 0 && dailyPageId) {
      await deleteBlock(dailyPageId)
      setDailyPageId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Date navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={goToPrevDay}>
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">{formatDateDisplay(date)}</span>
          {!isToday && (
            <Button variant="ghost" size="sm" onClick={goToToday}>
              Today
            </Button>
          )}
        </div>
        <Button variant="outline" onClick={goToNextDay}>
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Loading */}
      {loading && <div className="text-sm text-muted-foreground">Loading...</div>}

      {/* Block list */}
      {!loading && blocks.length > 0 && (
        <div className="space-y-2">
          {blocks.map((block) => (
            <div
              key={block.id}
              className="group flex items-center gap-2 rounded-lg border bg-card p-3"
            >
              <span className="flex-1 text-sm whitespace-pre-wrap">
                {block.content || '(empty)'}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                onClick={() => handleDeleteBlock(block.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && blocks.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No blocks for {formatDateDisplay(date)}. Add one below.
        </div>
      )}

      {/* Add block input */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleAddBlock()
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Write something..."
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={!newContent.trim()}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </form>
    </div>
  )
}
