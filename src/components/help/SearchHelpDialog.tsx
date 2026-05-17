/**
 * SearchHelpDialog — in-app reference for the search panel.
 *
 * Triggered by the `?` button in the search toolbar (wired up by the
 * panel itself; this component is a passive `open` / `onOpenChange`
 * sink so the parent owns trigger state).
 *
 * The five sections below are populated additively by follow-up plans:
 *   - Filter syntax    → PEND-54 (inline filter syntax + glob/tag)
 *   - Toggles          → PEND-55 (toggle row + history)
 *   - Regex syntax     → PEND-55
 *   - Boolean operators → PEND-55
 *   - Tips             → PEND-55 and later
 *
 * Skeleton-only by design: each section ships a single placeholder
 * paragraph that cross-links to the owning plan so a contributor
 * landing here knows exactly where the prose comes from. Do not
 * pre-fill content here — append it from the follow-up PRs.
 */

import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface SearchHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface HelpSection {
  /** Stable id used for the heading `id` attribute (anchor-friendly). */
  id: string
  /** Heading text. */
  title: string
  /** Placeholder body — replaced by follow-up plans, never deleted. */
  placeholder: string
}

const HELP_SECTIONS: ReadonlyArray<HelpSection> = [
  {
    id: 'filter-syntax',
    title: 'Filter syntax',
    placeholder: 'Coming soon — see pending/PEND-54-inline-filter-syntax.md.',
  },
  {
    id: 'toggles',
    title: 'Toggles',
    placeholder: 'Coming soon — see pending/PEND-55-search-toggles-history.md.',
  },
  {
    id: 'regex-syntax',
    title: 'Regex syntax',
    placeholder: 'Coming soon — see pending/PEND-55-search-toggles-history.md.',
  },
  {
    id: 'boolean-operators',
    title: 'Boolean operators',
    placeholder: 'Coming soon — see pending/PEND-55-search-toggles-history.md.',
  },
  {
    id: 'tips',
    title: 'Tips',
    placeholder: 'Coming soon — see pending/PEND-55-search-toggles-history.md.',
  },
]

export function SearchHelpDialog({ open, onOpenChange }: SearchHelpDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="search-help-title" data-testid="search-help-dialog">
        <DialogHeader>
          <DialogTitle id="search-help-title">{t('search.helpButtonLabel')}</DialogTitle>
          <DialogDescription>
            Search basics: paginated full-text search across blocks and pages.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {HELP_SECTIONS.map((section) => (
            <section key={section.id} aria-labelledby={`search-help-${section.id}`}>
              <h3
                id={`search-help-${section.id}`}
                className="text-base font-semibold leading-tight"
              >
                {section.title}
              </h3>
              <p className="text-muted-foreground text-sm">{section.placeholder}</p>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
