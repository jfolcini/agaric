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

// PEND-54 sees its content rendered inline (see `FilterSyntaxBody`).
// PEND-55 populates Toggles / Regex syntax / Boolean operators / Tips
// the same way — each section's body is rendered as its own component
// so the help dialog stays an additive scroll surface.
const HELP_SECTIONS: ReadonlyArray<HelpSection> = []

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

/** PEND-55 — Toggles section body. */
function TogglesBody() {
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        Three pressable buttons sit to the right of the input. Click a toggle to flip its mode (icon
        glows when active). State persists across sessions in localStorage.
      </p>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left">
            <th className="pr-3">Icon</th>
            <th className="pr-3">Mode</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3">Aa</td>
            <td className="pr-3">Case-sensitive</td>
            <td>Forces a post-FTS pass — has a cost even when other toggles are off.</td>
          </tr>
          <tr>
            <td className="pr-3">Ab|</td>
            <td className="pr-3">Whole word</td>
            <td>ASCII-only word boundary. CJK content does not match.</td>
          </tr>
          <tr>
            <td className="pr-3">.*</td>
            <td className="pr-3">Regex</td>
            <td>Bypasses the FTS index — the entire query becomes a Rust regex pattern.</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/** PEND-55 — Regex syntax section body. */
function RegexSyntaxBody() {
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        Regex mode uses the Rust <span className="font-mono">regex</span> crate (linear-time, no
        backtracking).
      </p>
      <ul className="list-disc pl-5">
        <li>
          <strong>No lookaround</strong>: <span className="font-mono">(?=…)</span>,{' '}
          <span className="font-mono">(?!…)</span>, <span className="font-mono">(?&lt;=…)</span>,{' '}
          <span className="font-mono">(?&lt;!…)</span> are not supported.
        </li>
        <li>
          <strong>No backreferences</strong>: <span className="font-mono">\1</span>,{' '}
          <span className="font-mono">\k&lt;name&gt;</span> are not supported.
        </li>
        <li>
          <strong>ASCII boundaries by default</strong>: <span className="font-mono">\b</span> only
          asserts between ASCII word chars. Use <span className="font-mono">(?u:\b)</span> for
          Unicode word boundaries.
        </li>
        <li>
          Inline flags <span className="font-mono">(?i)</span> /{' '}
          <span className="font-mono">(?m)</span> / <span className="font-mono">(?s)</span> /{' '}
          <span className="font-mono">(?x)</span> are supported.
        </li>
        <li>
          Caps: pattern length 1 KiB, compiled size 10 MiB, DFA cache 10 MiB, 50 match-offsets per
          block, 1000 pre-filter rows.
        </li>
      </ul>
      <p>
        Regex mode <strong>bypasses the FTS index</strong>: wall-time scales with the
        structurally-filtered block count, not the FTS candidate count. Anchor your regex (
        <span className="font-mono">^foo</span>, <span className="font-mono">bar$</span>,{' '}
        <span className="font-mono">\bword\b</span>) for tight queries.
      </p>
      <p>
        See{' '}
        <a className="underline" href="https://docs.rs/regex/latest/regex/#syntax">
          Rust regex syntax
        </a>{' '}
        for the full grammar. The in-page find (<span className="font-mono">Ctrl+F</span>) uses
        JavaScript&apos;s native <span className="font-mono">RegExp</span> instead — patterns may
        behave differently between the two surfaces; see{' '}
        <span className="font-mono">docs/SEARCH.md</span> for the cross-link.
      </p>
    </div>
  )
}

/** PEND-55 — Boolean operators section body. */
function BooleanOperatorsBody() {
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        Non-regex queries support three FTS5 boolean operators (uppercase on the wire, case-
        insensitive on input):
      </p>
      <ul className="list-disc pl-5">
        <li>
          <span className="font-mono">AND</span> — explicit intersection (the default).
        </li>
        <li>
          <span className="font-mono">OR</span> — union, e.g.{' '}
          <span className="font-mono">cats OR dogs</span>.
        </li>
        <li>
          <span className="font-mono">NOT</span> — negation,{' '}
          <span className="font-mono">meeting NOT cancelled</span>.
        </li>
      </ul>
      <p>
        Quoted phrases bypass the trigram length filter:{' '}
        <span className="font-mono">&quot;sprint plan&quot;</span> matches the literal phrase
        including 2-char tokens.
      </p>
      <p>Boolean operators do NOT apply inside regex mode (everything is treated as the regex).</p>
    </div>
  )
}

/** PEND-55 — Tips section body. */
function TipsBody() {
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        <strong>Recall recent queries with</strong>{' '}
        <kbd className="rounded border px-1 font-mono text-xs">↑</kbd> /{' '}
        <kbd className="rounded border px-1 font-mono text-xs">↓</kbd> when the input is empty.
      </p>
      <ul className="list-disc pl-5">
        <li>History dedupes — re-submitting the same query moves it to the front.</li>
        <li>Per-space partitioning — recall stays inside the current space.</li>
        <li>
          The dropdown surfaces the last 20 submitted queries; pressing past the newest entry clears
          the input.
        </li>
        <li>
          Clear the per-space history via the footer button below the dropdown — other spaces stay
          untouched.
        </li>
        <li>Toggle state survives reloads (stored in localStorage).</li>
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
          {/* PEND-55 — Toggles. */}
          <section aria-labelledby="search-help-toggles">
            <h3 id="search-help-toggles" className="text-base font-semibold leading-tight">
              Toggles
            </h3>
            <TogglesBody />
          </section>
          {/* PEND-55 — Regex syntax. */}
          <section aria-labelledby="search-help-regex-syntax">
            <h3 id="search-help-regex-syntax" className="text-base font-semibold leading-tight">
              Regex syntax
            </h3>
            <RegexSyntaxBody />
          </section>
          {/* PEND-55 — Boolean operators. */}
          <section aria-labelledby="search-help-boolean-operators">
            <h3
              id="search-help-boolean-operators"
              className="text-base font-semibold leading-tight"
            >
              Boolean operators
            </h3>
            <BooleanOperatorsBody />
          </section>
          {/* PEND-55 — Tips. */}
          <section aria-labelledby="search-help-tips">
            <h3 id="search-help-tips" className="text-base font-semibold leading-tight">
              Tips
            </h3>
            <TipsBody />
          </section>
          {/* Backfill from `HELP_SECTIONS` for any deferred section. */}
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
