/**
 * InPageFind — browser-style find-in-page toolbar (PEND-52).
 *
 * Renders nothing when the store's `open` flag is false. When open,
 * mounts a thin overlay anchored to the top of the page-content
 * scroll area, runs the matcher against the registered host
 * container, and drives the highlight registry via the highlighter
 * module.
 *
 * Inputs:
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
 *
 * Mobile keyboard handling — even though the touch entry-point is
 * deferred (open question Q1 — see report), if the toolbar is opened
 * via a hardware keyboard on a touchscreen laptop the input must stay
 * visible above any soft keyboard. We subscribe to `window.visualViewport`
 * and translate the toolbar by the negative viewport delta.
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
import { cn } from '@/lib/utils'
import {
  clear as clearHighlights,
  paint,
  scrollIntoViewMatch,
} from '../lib/in-page-find/highlighter'
import {
  collectTextNodes,
  compileQuery,
  type FindMatch,
  type FindResult,
  runWalker,
  type WalkerHandle,
} from '../lib/in-page-find/matcher'
import { useInPageFindStore } from '../stores/useInPageFindStore'

/**
 * Compute the y-offset needed so the toolbar floats above any visible
 * soft keyboard. `window.visualViewport.height` is the layout-viewport
 * height MINUS the keyboard; subtracting `window.innerHeight` yields
 * a negative number when the keyboard is up. Falls back to 0 outside
 * browsers that expose the API (every test under happy-dom).
 */
function computeViewportOffset(): number {
  const vv = (typeof window !== 'undefined' && window.visualViewport) || null
  if (!vv) return 0
  return vv.height - window.innerHeight
}

export function InPageFind(): React.ReactElement | null {
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
  useEffect(() => {
    if (!open) return
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
  }, [open])

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
    const handle = runWalker(textNodes, compiled, {
      onProgress: (partial: FindResult) => {
        matchesRef.current = partial.matches
        // Mid-walk: surface the partial count but don't paint yet — the
        // final paint happens in onComplete so we don't pay N highlights
        // for each chunk on long pages.
        setResult({
          totalMatches: partial.matches.length,
          currentIndex: partial.matches.length > 0 ? 0 : -1,
          regexError: null,
          skippedLongNodes: partial.skippedLongNodes,
        })
      },
      onComplete: (final: FindResult) => {
        matchesRef.current = final.matches
        const startIndex = final.matches.length > 0 ? 0 : -1
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
  useEffect(() => {
    return () => {
      clearHighlights()
    }
  }, [])

  // ── F3 / Shift+F3 — global next/prev while the toolbar is open. Bound
  // at window so the user doesn't have to focus the input first.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'F3') return
      e.preventDefault()
      if (e.shiftKey) prevMatch()
      else nextMatch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, nextMatch, prevMatch])

  const handleClose = useCallback(() => {
    close()
    // Restore focus to whatever the user was editing/reading before.
    // `?? null` because `requestAnimationFrame` is preferred so the
    // close transition completes before focus snaps back.
    const target = returnFocusRef.current
    if (target && document.contains(target)) {
      requestAnimationFrame(() => target.focus())
    }
  }, [close])

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
        // Anchored at the top of the viewport, centred horizontally.
        // `fixed` so it floats above whichever view is rendered (Journal,
        // PageEditor, …) without each view having to participate.
        'fixed top-2 right-2 md:right-4 z-50 flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1.5 shadow-lg',
        'transition-transform duration-100',
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
        className="h-7 w-48 md:w-64 text-sm"
      />

      {/* Toggle row — `Aa` / `Ab|` / `.*` */}
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

      {/* Match counter — `role="status"` + `aria-live="polite"`. */}
      <span
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

      {regexError && (
        <span
          id="in-page-find-error"
          role="alert"
          data-testid="in-page-find-error"
          className="ml-2 text-xs text-destructive"
        >
          {regexError === 'findInPage.regexTooLong'
            ? t('findInPage.regexTooLong')
            : t('findInPage.regexInvalid', { message: regexError })}
        </span>
      )}
      {skippedLongNodes > 0 && !regexError && (
        <span
          role="status"
          aria-live="polite"
          data-testid="in-page-find-skipped"
          className="ml-2 text-xs text-muted-foreground"
        >
          {t('findInPage.skippedLongPassages', { count: skippedLongNodes })}
        </span>
      )}
    </div>
  )
}
