/**
 * TagValuePicker — searchable tag autocomplete for filter builders.
 *
 * Drop-in replacement for TextValuePicker when filtering by tag.
 * Calls listTagsByPrefix() on each keystroke, shows matching tags
 * in a dropdown, and stores the selected tag **name** as the value.
 * Query execution (agenda-filters.ts) resolves names to IDs.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { listTagsByPrefix } from '../lib/tauri'

interface TagResult {
  tag_id: string
  name: string
  usage_count: number
}

export function TagValuePicker({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (values: string[]) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [query, setQuery] = useState(selected[0] ?? '')
  const [results, setResults] = useState<TagResult[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const search = useCallback(async (prefix: string) => {
    try {
      const tags = await listTagsByPrefix({ prefix, limit: 20 })
      setResults(
        tags.map((tag) => ({
          tag_id: tag.tag_id,
          name: tag.name,
          usage_count: tag.usage_count,
        })),
      )
      setActiveIndex(-1)
      setOpen(true)
    } catch {
      setResults([])
      setActiveIndex(-1)
    }
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setQuery(value)
      onChange([])
      if (value.trim()) {
        search(value.trim())
      } else {
        setResults([])
        setOpen(false)
      }
    },
    [onChange, search],
  )

  const handleSelect = useCallback(
    (tag: TagResult) => {
      setQuery(tag.name)
      onChange([tag.name])
      setOpen(false)
      setActiveIndex(-1)
    },
    [onChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open || results.length === 0) {
        if (e.key === 'ArrowDown' && results.length > 0) {
          e.preventDefault()
          setOpen(true)
          setActiveIndex(0)
        }
        return
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex((prev) => Math.min(prev + 1, results.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Enter': {
          const item = results[activeIndex]
          if (activeIndex >= 0 && activeIndex < results.length && item) {
            e.preventDefault()
            handleSelect(item)
          }
          break
        }
        case 'Escape':
          e.preventDefault()
          setOpen(false)
          setActiveIndex(-1)
          break
      }
    },
    [open, results, activeIndex, handleSelect],
  )

  // Scroll active option into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const option = listRef.current.children[activeIndex] as HTMLElement | undefined
      if (typeof option?.scrollIntoView === 'function') {
        option.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [activeIndex])

  // Close dropdown on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setActiveIndex(-1)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const activeId = activeIndex >= 0 ? `tag-option-${results[activeIndex]?.tag_id}` : undefined
  const listboxId = 'tag-value-picker-listbox'
  const isExpanded = open && results.length > 0

  return (
    <div ref={containerRef} className="relative">
      <Input
        className="h-7 text-xs"
        placeholder={t('agendaFilter.tagPlaceholder')}
        value={query}
        onChange={handleChange}
        onFocus={() => {
          if (query.trim() && results.length > 0) setOpen(true)
        }}
        onKeyDown={handleKeyDown}
        aria-label={t('agendaFilter.tagName')}
        role="combobox"
        aria-expanded={isExpanded}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-controls={isExpanded ? listboxId : undefined}
      />
      {isExpanded && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <ScrollArea className="max-h-40">
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              className="py-1"
              aria-label={t('agendaFilter.tagSearchResults')}
            >
              {results.map((tag, idx) => (
                <div
                  key={tag.tag_id}
                  id={`tag-option-${tag.tag_id}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={idx === activeIndex}
                  className={cn(
                    'cursor-pointer px-2 py-1.5 text-xs hover:bg-accent',
                    idx === activeIndex && 'bg-accent',
                  )}
                  onClick={() => handleSelect(tag)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleSelect(tag)
                  }}
                >
                  {tag.name}
                  <span className="ml-1 text-muted-foreground">({tag.usage_count})</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
