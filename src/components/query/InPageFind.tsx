/**
 * InPageFind — browser-style find-in-page toolbar.
 *
 * Renders nothing when the store's `open` flag is false. When open,
 * mounts a thin toolbar that runs the matcher against the registered
 * host container and drives the highlight registry via the highlighter
 * module.
 *
 * Two render variants:
 *  - `variant="overlay"` (default) — free-floating overlay anchored at
 *    the top-right of the viewport. Tracks `window.visualViewport` so
 *    the toolbar floats above the iOS soft keyboard. This is the
 *    desktop Ctrl+F path.
 *  - `variant="embedded"` — same toolbar, no fixed positioning, no
 *    visualViewport offset. The parent container (the unified mobile
 *    search sheet's "In this page" segment) provides positioning and
 *    keyboard-aware sizing via `dvh`. Mutually exclusive with the
 *    overlay variant: when the search sheet is open in `'in-page'`
 *    mode the overlay returns `null` so the matcher / highlighter
 *    effects only run once.
 *
 * Inputs (both variants):
 *  - Toolbar input is autofocused on mount; whatever was selected in
 *    the page becomes the initial query (browser convention). When no
 *    selection exists the store restores the previous query (Q3).
 *  - `Aa` toggles case sensitivity. `Ab|` toggles whole-word.
 *    `.*` toggles regex (Phase 2 of the plan — landed together with
 *    Phase 1).
 *  - `↑`/`↓` arrows and `Enter`/`Shift+Enter` cycle matches.
 *  - `Esc` closes the toolbar and restores editor focus to the
 *    previously-focused element captured on open.
 *
 * Accessibility (per the plan's a11y section):
 *  - `role="toolbar"` on the outer container with
 *    `aria-label={t('findInPage.toolbarLabel')}`.
 *  - Each toggle has `aria-pressed={isActive}`.
 *  - Match counter has `role="status"` + `aria-live="polite"` so SRs
 *    announce "3 of 12 matches" updates without stealing focus.
 */

import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  clear as clearHighlights,
  paint,
  scrollIntoViewMatch,
} from '@/lib/in-page-find/highlighter'
import {
  collectTextNodes,
  compileQuery,
  type FindMatch,
  type FindResult,
  runWalker,
  type WalkerHandle,
} from '@/lib/in-page-find/matcher'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { cn } from '@/lib/utils'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

/**
 * Compute the y-offset needed so the toolbar floats above any visible
 * soft keyboard. `window.visualViewport.height` is the layout-viewport
 * height MINUS the keyboard; subtracting `window.innerHeight` yields
 * a negative number when the keyboard is up. Falls back to 0 outside
 * browsers that expose the API (every test under happy-dom).
 *
 * Pinch zoom ALSO shrinks `visualViewport.height` without any keyboard —
 * on a desktop browser / touchscreen (trackpad pinch, WebView2 touch
 * zoom) a zoomed viewport would otherwise float the toolbar up by a bogus
 * "keyboard" offset. `scale > 1` is the discriminator: the IME never
 * changes scale, pinch zoom always does. Treat a zoomed viewport as "no
 * keyboard" and return 0. (`undefined > 1` is false, so WebViews lacking
 * `scale` keep the plain keyboard math.) Mirrors the #760 guard in
 * `useSoftKeyboardInset` (src/components/ui/sheet.tsx).
 */
function computeViewportOffset(): number {
  const vv = (typeof window !== 'undefined' && window.visualViewport) || null
  if (!vv) return 0
  if (vv.scale > 1) return 0
  return vv.height - window.innerHeight
}

export type InPageFindVariant = 'overlay' | 'embedded'

interface InPageFindProps {
  /**
   * Render style. `'overlay'` (default) is the free-floating toolbar
   * used by the desktop Ctrl+F path. `'embedded'` drops the fixed
   * positioning + visualViewport offset so a parent container (the
   * mobile search sheet's "In this page" body) can mount the same
   * toolbar inline.
   */
  variant?: InPageFindVariant
  /**
   * Embedded-variant only: override what happens when the user taps
   * the close button or presses Escape. The overlay variant calls
   * `useInPageFindStore.close()` directly — but doing the same in
   * the embedded path leaves the parent Sheet rendering a now-empty
   * toolbar (because the find store flips `open=false` while the
   * sheet body still wants to mount the toolbar). The parent
   * SearchSheet passes a closure that closes the SHEET instead,
   * matching the user's "tap X to dismiss" intent.
   */
  onCloseRequest?: () => void
}

export function InPageFind({
  variant = 'overlay',
  onCloseRequest,
}: InPageFindProps = {}): React.ReactElement | null {
  const { t } = useTranslation()
  const {
    open,
    query,
    toggles,
    totalMatches,
    currentIndex,
    regexError,
    skippedLongNodes,
    container,
  } = useInPageFindStore(
    useShallow((s) => ({
      open: s.open,
      query: s.query,
      toggles: s.toggles,
      totalMatches: s.totalMatches,
      currentIndex: s.currentIndex,
      regexError: s.regexError,
      skippedLongNodes: s.skippedLongNodes,
      container: s.container,
    })),
  )
  const setQuery = useInPageFindStore((s) => s.setQuery)
  const setToggles = useInPageFindStore((s) => s.setToggles)
  const setResult = useInPageFindStore((s) => s.setResult)
  const nextMatch = useInPageFindStore((s) => s.next)
  const prevMatch = useInPageFindStore((s) => s.previous)
  const close = useInPageFindStore((s) => s.close)

  const inputRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  // The matches list is shared between the walker driver effect (writes)
  // and the navigation/scroll effect (reads). We keep it in a ref so the
  // navigation effect doesn't re-subscribe on every chunked progress
  // update during a long walk.
  const matchesRef = useRef<FindMatch[]>([])
  // Active walker handle — abort when the user types again before the
  // previous walk completes.
  const walkerRef = useRef<WalkerHandle | null>(null)
  // Element to refocus on close (saved when the toolbar opens).
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // ── Auto-focus the input on open + capture the return-focus target.
  // `useLayoutEffect` so the focus shift happens before paint, matching the
  // browser's native Ctrl+F snap.
  useLayoutEffect(() => {
    if (!open) {
      returnFocusRef.current = null
      return
    }
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open])

  // ── visualViewport — keep the toolbar above the soft keyboard.
  // Embedded variant skips this: the parent Sheet sizes itself via
  // `dvh` (dynamic viewport height) and re-renders on keyboard show,
  // so the embedded toolbar already floats above the keyboard for free.
  useEffect(() => {
    if (!open || variant === 'embedded') return
    const apply = () => {
      const el = toolbarRef.current
      if (!el) return
      const offset = computeViewportOffset()
      el.style.transform = offset < 0 ? `translateY(${offset}px)` : ''
    }
    apply()
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [open, variant])

  // ── Matcher driver. Re-runs every time the query, toggles, or container
  // change. Aborts the in-flight walker first so a fast-typing user never
  // observes counters from a stale run.
  useEffect(() => {
    if (!open) {
      clearHighlights()
      matchesRef.current = []
      return
    }
    if (!container) {
      clearHighlights()
      matchesRef.current = []
      setResult({ totalMatches: 0, currentIndex: -1, regexError: null, skippedLongNodes: 0 })
      return
    }
    walkerRef.current?.cancel()
    const compiled = compileQuery(query, toggles)
    if (compiled.kind === 'empty') {
      clearHighlights()
      matchesRef.current = []
      setResult({ totalMatches: 0, currentIndex: -1, regexError: null, skippedLongNodes: 0 })
      return
    }
    if (compiled.kind === 'error') {
      clearHighlights()
      matchesRef.current = []
      setResult({
        totalMatches: 0,
        currentIndex: -1,
        regexError: compiled.message,
        skippedLongNodes: 0,
      })
      return
    }
    const textNodes = collectTextNodes(container)
    // Index this walk last published via `setResult`. A fresh walk always
    // starts at the first match — but if the store's index has moved away
    // from what we last published, the user pressed Enter/F3 mid-walk
    // (chunked pages), and resetting to 0 on every chunk would throw their
    // position away. Preserve it instead, clamped to the still-growing
    // match list (matches append in document order, so indices are stable).
    let publishedIndex: number | null = null
    const indexFor = (matchCount: number): number => {
      if (matchCount === 0) return -1
      const storeIndex = useInPageFindStore.getState().currentIndex
      const desired =
        publishedIndex !== null && storeIndex !== publishedIndex
          ? storeIndex // user navigated since our last publish — keep it
          : (publishedIndex ?? 0) // fresh walk → first match; else hold position
      const next = Math.min(Math.max(desired, 0), matchCount - 1)
      publishedIndex = next
      return next
    }
    const handle = runWalker(textNodes, compiled, {
      onProgress: (partial: FindResult) => {
        matchesRef.current = partial.matches
        // Mid-walk: surface the partial count but don't paint yet — the
        // final paint happens in onComplete so we don't pay N highlights
        // for each chunk on long pages.
        setResult({
          totalMatches: partial.matches.length,
          currentIndex: indexFor(partial.matches.length),
          regexError: null,
          skippedLongNodes: partial.skippedLongNodes,
        })
      },
      onComplete: (final: FindResult) => {
        matchesRef.current = final.matches
        const startIndex = indexFor(final.matches.length)
        setResult({
          totalMatches: final.matches.length,
          currentIndex: startIndex,
          regexError: null,
          skippedLongNodes: final.skippedLongNodes,
        })
        paint(final.matches, startIndex)
        if (startIndex >= 0) {
          const first = final.matches[startIndex]
          if (first) scrollIntoViewMatch(first)
        }
      },
    })
    walkerRef.current = handle
    return () => {
      handle.cancel()
    }
  }, [open, query, toggles, container, setResult])

  // ── Repaint and scroll when the current index changes (arrow navigation).
  useEffect(() => {
    if (!open) return
    const matches = matchesRef.current
    paint(matches, currentIndex)
    if (currentIndex >= 0) {
      const m = matches[currentIndex]
      if (m) scrollIntoViewMatch(m)
    }
  }, [open, currentIndex])

  // ── Clear highlights on unmount.
  useEffect(
    () => () => {
      clearHighlights()
    },
    [],
  )

  // ── findInPageNext / findInPagePrev (F3 / Shift+F3 by default) — global
  // next/prev while the toolbar is open. Bound at window so the user
  // doesn't have to focus the input first. Routed through
  // `matchesShortcutBinding` (#724) so Settings rebinds are honoured;
  // the more-specific Shift chord is checked first.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (matchesShortcutBinding(e, 'findInPagePrev')) {
        e.preventDefault()
        prevMatch()
        return
      }
      if (matchesShortcutBinding(e, 'findInPageNext')) {
        e.preventDefault()
        nextMatch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, nextMatch, prevMatch])

  const handleClose = useCallback(() => {
    // Embedded variant: route the dismissal to the parent (the
    // mobile search sheet closes itself). The parent's lifecycle
    // bridge will then close the find store as part of its cleanup
    // — calling `close()` here would race that and leave the sheet
    // body stuck rendering a now-blank toolbar.
    if (onCloseRequest) {
      onCloseRequest()
      return
    }
    close()
    // Restore focus to whatever the user was editing/reading before.
    // `requestAnimationFrame` so the close transition completes
    // before focus snaps back.
    const target = returnFocusRef.current
    if (target && document.contains(target)) {
      requestAnimationFrame(() => target.focus())
    }
  }, [close, onCloseRequest])

  const handleInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) prevMatch()
        else nextMatch()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleClose()
      }
    },
    [handleClose, nextMatch, prevMatch],
  )

  // Match-counter rendering. `0 of 0` for empty / no-match. `—` while a
  // regex is invalid (so the user understands the count is paused).
  const counterText = (() => {
    if (regexError) return '—'
    if (totalMatches === 0) return t('findInPage.counterEmpty')
    return t('findInPage.counter', { current: currentIndex + 1, total: totalMatches })
  })()

  if (!open) return null

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t('findInPage.toolbarLabel')}
      data-testid="in-page-find-toolbar"
      data-find-skip
      className={cn(
        // Shared chrome: rounded card holding the input + toggles +
        // counter + arrows. Tight gap so it reads as one unit.
        'rounded-md border border-border px-2 py-1.5',
        variant === 'overlay' &&
          // Single-row free-floating overlay anchored top-right.
          // `fixed` so it floats above whichever view is rendered
          // without each view having to participate.
          'fixed top-2 right-2 md:right-4 z-50 flex items-center gap-1.5 bg-popover shadow-(--shadow-overlay) transition-transform duration-fast',
        variant === 'embedded' &&
          // Two intentional rows inside the search sheet — row 1 is
          // the input across the full width; row 2 is the controls.
          // At 390 px (iPhone 13) the 8-control single row simply
          // doesn't fit; this layout keeps each touch target ≥ 44 px
          // (the coarse-pointer override on Button) without
          // requiring wrap-into-chaos.
          'flex flex-col gap-2 bg-background',
      )}
    >
      <Input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={t('findInPage.inputPlaceholder')}
        aria-label={t('findInPage.inputLabel')}
        aria-invalid={regexError != null ? true : undefined}
        aria-errormessage={regexError ? 'in-page-find-error' : undefined}
        data-testid="in-page-find-input"
        className={cn(
          'text-sm',
          // Overlay: compact 7-row inline strip. Embedded: full row 1
          // inside the sheet — default Input height matches the
          // 44-px touch targets on row 2.
          variant === 'overlay' ? 'h-7 w-48 md:w-64' : 'w-full',
        )}
      />
      {/* Controls split into two logical groups: toggles (case /
          whole-word / regex) and navigation (counter + prev/next/
          close). On the overlay both groups inline into a single
          flat row (outer `flex items-center`); on embedded the outer
          is `flex flex-col` so the groups stack — overlapping the
          input at row 1 — into a stable 3-row layout that fits 390 px
          phones without flex-wrap chaos.

          Single-row math at 390 px (sheet padding ~32 + card padding
          16 → 342 px usable): row 2 toggles 3 × 44 + 2 × 6 = 144 ✓;
          row 3 counter (4.5rem) + 3 × 44 + 4 × 6 = 228 ✓. */}
      <div className="flex items-center gap-1.5" data-testid="in-page-find-toggles">
        <Button
          type="button"
          variant={toggles.caseSensitive ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-pressed={toggles.caseSensitive}
          aria-label={t('findInPage.toggleCaseSensitive')}
          title={t('findInPage.toggleCaseSensitive')}
          data-testid="in-page-find-toggle-case"
          onClick={() => setToggles({ caseSensitive: !toggles.caseSensitive })}
        >
          <CaseSensitive aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant={toggles.wholeWord ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-pressed={toggles.wholeWord}
          aria-label={t('findInPage.toggleWholeWord')}
          title={t('findInPage.toggleWholeWord')}
          data-testid="in-page-find-toggle-word"
          onClick={() => setToggles({ wholeWord: !toggles.wholeWord })}
        >
          <WholeWord aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant={toggles.isRegex ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-pressed={toggles.isRegex}
          aria-label={t('findInPage.toggleRegex')}
          title={t('findInPage.toggleRegex')}
          data-testid="in-page-find-toggle-regex"
          onClick={() => setToggles({ isRegex: !toggles.isRegex })}
        >
          <Regex aria-hidden="true" />
        </Button>
      </div>

      <div
        className={cn(
          'flex items-center gap-1.5',
          // On embedded, push the close button to the right by
          // stretching this row to full width; on overlay the row
          // sits inline with the toggle group above.
          variant === 'embedded' && 'w-full',
        )}
        data-testid="in-page-find-nav"
      >
        <span
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- explicit role="status" is asserted by the InPageFind a11y test and kept on the <span> so the counter stays a span-styled inline live region; <output> would change the element identity the toolbar layout/tests depend on
          role="status"
          aria-live="polite"
          data-testid="in-page-find-counter"
          className={cn(
            'min-w-[4.5rem] text-center text-xs',
            totalMatches === 0 || regexError ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {counterText}
        </span>
        {variant === 'embedded' && <span className="flex-1" />}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('findInPage.previousMatch')}
          title={t('findInPage.previousMatch')}
          disabled={totalMatches === 0}
          data-testid="in-page-find-previous"
          onClick={() => prevMatch()}
        >
          <ChevronUp aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('findInPage.nextMatch')}
          title={t('findInPage.nextMatch')}
          disabled={totalMatches === 0}
          data-testid="in-page-find-next"
          onClick={() => nextMatch()}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('findInPage.close')}
          title={t('findInPage.close')}
          data-testid="in-page-find-close"
          onClick={handleClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      {regexError && (
        <span
          id="in-page-find-error"
          role="alert"
          data-testid="in-page-find-error"
          className="text-xs text-destructive"
        >
          {regexError === 'findInPage.regexTooLong'
            ? t('findInPage.regexTooLong')
            : t('findInPage.regexInvalid', { message: regexError })}
        </span>
      )}
      {skippedLongNodes > 0 && !regexError && (
        <span
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- sibling inline status span matching the counter's role="status" convention in this toolbar; kept a <span> for layout/markup consistency rather than swapping to <output>
          role="status"
          aria-live="polite"
          data-testid="in-page-find-skipped"
          className="text-xs text-muted-foreground"
        >
          {t('findInPage.skippedLongPassages', { count: skippedLongNodes })}
        </span>
      )}
    </div>
  )
}
