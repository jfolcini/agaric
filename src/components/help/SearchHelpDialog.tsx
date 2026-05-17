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
  // PEND-54 — Filter syntax is now populated; the body is rendered
  // inline below (see `FilterSyntaxBody`).
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

/** PEND-54 — Filter syntax section body. */
function FilterSyntaxBody() {
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        Filters can be typed directly in the search input or added via the{' '}
        <span className="font-mono">+ Filter ▾</span> button. Filters AND-combine with the free-text
        portion.
      </p>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left">
            <th className="pr-3">Token</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3">tag:#name</td>
            <td>Block carries the tag `name`. Repeats AND.</td>
          </tr>
          <tr>
            <td className="pr-3">#name</td>
            <td>Bare alias for tag:#name.</td>
          </tr>
          <tr>
            <td className="pr-3">path:GLOB</td>
            <td>Page-name glob include. Comma-separated values OR-combine.</td>
          </tr>
          <tr>
            <td className="pr-3">not-path:GLOB</td>
            <td>Page-name glob exclude.</td>
          </tr>
          <tr>
            <td className="pr-3">"phrase"</td>
            <td>Quoted phrase — passed to FTS5 verbatim.</td>
          </tr>
          <tr>
            <td className="pr-3">AND / OR / NOT</td>
            <td>Boolean operators (uppercase) — passed to FTS5.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Glob filters are <strong>case-insensitive</strong> and match against the page title. A bare
        token like <span className="font-mono">path:Journal</span> wraps to{' '}
        <span className="font-mono">*Journal*</span> (substring match); add{' '}
        <span className="font-mono">*</span>, <span className="font-mono">?</span>, or{' '}
        <span className="font-mono">[...]</span> for explicit glob syntax.{' '}
        <span className="font-mono">{'{a,b}'}</span> brace-expansion is supported (no nesting).
      </p>
      <p>Examples:</p>
      <ul className="list-disc pl-5">
        <li>
          <span className="font-mono">TODO path:Journal/2026-* tag:#urgent</span> — TODOs on January
          2026 journal pages tagged urgent.
        </li>
        <li>
          <span className="font-mono">tag:#meeting not-path:Archive/**</span> — meetings outside the
          archive.
        </li>
        <li>
          <span className="font-mono">path:{'{Journal,Notes}'}/*</span> — match pages in either
          Journal or Notes.
        </li>
      </ul>
    </div>
  )
}

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
          {/* PEND-54 — Filter syntax section (populated). */}
          <section aria-labelledby="search-help-filter-syntax">
            <h3 id="search-help-filter-syntax" className="text-base font-semibold leading-tight">
              Filter syntax
            </h3>
            <FilterSyntaxBody />
          </section>
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
