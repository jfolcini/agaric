/**
 * A side sheet listing reference entries in sections, with a filter: the
 * Markdown and slash-command references the page editor's hint opens. A
 * bottom sheet on a phone. Marked `data-editor-portal`, so opening it from the
 * editor does not end page mode's touch editing; closing it gives the focus
 * back to what had it.
 */

import type React from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { SearchInput } from '@/components/ui/search-input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getActiveEditor } from '@/editor/active-editor'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'
import { matchesSearchFolded } from '@/lib/fold-for-search'

export interface ReferenceEntry {
  id: string
  name: string
  /** What the user types, shown as code. */
  syntax?: string
  description: string
  /** Shown beside the name, such as a keyboard shortcut. */
  aside?: React.ReactNode
}

export interface ReferenceSection {
  id: string
  heading: string
  entries: readonly ReferenceEntry[]
}

interface ReferenceSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  filterLabel: string
  sections: readonly ReferenceSection[]
}

function matches(entry: ReferenceEntry, heading: string, needle: string): boolean {
  return [entry.name, entry.syntax ?? '', entry.description, heading].some((text) =>
    matchesSearchFolded(text, needle),
  )
}

export function ReferenceSheet({
  open,
  onOpenChange,
  title,
  description,
  filterLabel,
  sections,
}: ReferenceSheetProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const isMobile = useIsMobile()
  const [filter, setFilter] = useState('')
  const opener = useRef<Element | null>(null)
  const needle = filter.trim()
  const shown = sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((e) => needle === '' || matches(e, section.heading, needle)),
    }))
    .filter((section) => section.entries.length > 0)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setFilter('')
        onOpenChange(next)
      }}
    >
      <SheetContent
        side={isTouch && isMobile ? 'bottom' : 'right'}
        data-editor-portal=""
        onOpenAutoFocus={() => {
          opener.current = document.activeElement
        }}
        // Radix gives the focus back only to a `Dialog.Trigger`; there is none,
        // so give it to what had it, an editor with its selection.
        onCloseAutoFocus={(e) => {
          const editor = getActiveEditor()
          if (editor !== null && editor.view.dom.contains(opener.current)) {
            e.preventDefault()
            editor.commands.focus()
          } else if (opener.current instanceof HTMLElement && opener.current.isConnected) {
            e.preventDefault()
            opener.current.focus()
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
          <SearchInput
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={filterLabel}
            aria-label={filterLabel}
            wrapperClassName="mt-2"
          />
        </SheetHeader>
        <SheetBody>
          {shown.length === 0 ? (
            <EmptyState
              compact
              headingLevel="h3"
              message={t('referenceSheet.noMatches', { filter: needle })}
            />
          ) : (
            shown.map((section) => (
              <section key={section.id} aria-labelledby={`reference-${section.id}`}>
                <h3
                  id={`reference-${section.id}`}
                  className="mb-1 text-xs font-semibold text-muted-foreground"
                >
                  {section.heading}
                </h3>
                <ul className="text-sm">
                  {section.entries.map((entry) => (
                    <li key={entry.id} className="border-b border-border py-2 last:border-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-foreground">{entry.name}</span>
                        {entry.aside}
                      </div>
                      {entry.syntax !== undefined && (
                        <code className="mt-1 block whitespace-pre-wrap break-all rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {entry.syntax}
                        </code>
                      )}
                      <p className="mt-1 text-muted-foreground">{entry.description}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
