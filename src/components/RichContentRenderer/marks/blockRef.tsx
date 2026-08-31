import type React from 'react'

import type { RenderContext } from '@/components/RichContentRenderer/context'
import type { BlockRefNode } from '@/editor/types'
import { unresolvedBlockLabel, unresolvedBlockRefLabel } from '@/lib/block-title'
import { cn } from '@/lib/utils'

/**
 * Build the event-handler + role props bundle for a clickable block-ref chip.
 * Mirrors `tagRefProps` / `blockLinkProps`: returns `{ role: 'link', tabIndex: 0,
 * onClick, onKeyDown }` with Enter + Space activation and `stopPropagation` on
 * every handler.
 *
 * Only spread when the chip is clickable (handler AND interactive). The caller
 * gates on both conditions, so this helper only ever produces the active bag.
 */
function blockRefProps(refId: string, onNavigate: (id: string) => void): Record<string, unknown> {
  return {
    role: 'link',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onNavigate(refId)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onNavigate(refId)
      }
    },
  }
}

export function renderBlockRef(
  node: BlockRefNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const refId = node.attrs.id
  // #4228 — the resolve store already holds the normalised, display-ready
  // title (first line, capped, Untitled-substituted — see
  // `normalizeBlockRefTitle` in `@/lib/block-title`), applied once at every
  // seed call site. Render it verbatim: no per-renderer split/cap here to
  // disagree with the seed or with the TipTap `BlockRef` NodeView
  // (`@/editor/extensions/block-ref.ts`), which renders the same value the
  // same way. #4551 extends that parity to the UNRESOLVED case too: the
  // `BlockRef.configure({ resolveContent })` wiring in `use-roving-editor.ts`
  // runs the identical by-value substitution below, so a broken ref reads
  // `(( id… ))` whether it is clicked into or not.
  const resolved = ctx.resolveBlockTitle?.(refId)
  // #4551 — `ctx.resolveBlockTitle` is the SAME callback `renderBlockLink`
  // uses for `[[ULID]]` page links, so an unresolved id comes back either as
  // `undefined` or as `unresolvedBlockLabel`'s `[[id…]]` PAGE-link shape,
  // depending on which resolver is wired — never on whether a resolver is
  // wired at all:
  //
  //   - `undefined` — either `ctx.resolveBlockTitle` itself is not provided
  //     (the optional-chaining call above short-circuits), or it IS provided
  //     but is one like `useRichContentCallbacks.resolveBlockTitle`
  //     (`@/hooks/useRichContentCallbacks.ts`), which returns `undefined` on
  //     an ordinary cache miss — a resolver wired and working, just nothing
  //     cached yet for this id.
  //   - `unresolvedBlockLabel`'s `[[id…]]` shape — the wired resolver applies
  //     its OWN by-value "nothing resolved for this id" fallback before
  //     returning (e.g. `use-block-resolve.ts`'s `resolveBlockTitle`,
  //     `useBacklinkResolution`'s), so the miss never reaches here as
  //     `undefined` at all.
  //
  // This chip is a BLOCK reference either way, so both cases render the
  // `(( id… ))` shape instead of quietly showing the wrong kind of broken.
  //
  // Known and accepted collision, recorded rather than designed around: the
  // miss is detected by VALUE, because `resolveBlockTitle` returns a bare
  // string with no separate "did not resolve" signal. A block whose real
  // title happens to be exactly `[[<its own first 8 chars>...]]` therefore
  // renders as `(( … ))` too. Reaching it needs a title matching the
  // truncation of the very id being resolved; the cost if someone does is a
  // cosmetically wrong chip label, not a wrong target. The structural fix is
  // for resolvers to return `undefined` on a miss instead of a formatted
  // string, which is a change to every caller of `resolveBlockTitle` and is
  // deliberately not in this diff.
  const title =
    resolved === undefined || resolved === unresolvedBlockLabel(refId)
      ? unresolvedBlockRefLabel(refId)
      : resolved
  const status = ctx.resolveBlockStatus?.(refId) ?? 'active'
  const deletedProps = status === 'deleted' ? { 'aria-label': `${title} (deleted)` } : {}
  // Unified chip interactivity policy (matches tagRef / blockLink):
  // - clickable (handler AND interactive) → full affordances: role=link,
  //   tabIndex=0, key/click handlers, cursor-pointer.
  // - interactive but no handler → inert focus parity: tabIndex=0 only.
  // - not interactive → fully inert: no role, no tabIndex, no handlers, no
  //   cursor-pointer.
  const clickable = ctx.onNavigate !== undefined && ctx.interactive === true
  const inertProps: Record<string, unknown> = ctx.interactive === true ? { tabIndex: 0 } : {}
  const interactiveProps = clickable
    ? blockRefProps(refId, ctx.onNavigate as (id: string) => void)
    : inertProps
  return (
    <span
      key={key}
      className={cn(
        'block-ref-chip',
        clickable && 'cursor-pointer',
        status === 'deleted' && 'block-ref-deleted',
      )}
      data-testid="block-ref-chip"
      // The reveal for a chip clipped by `.block-ref-chip`'s `max-width`.
      //
      // #4228 replaced a Radix `<Tooltip>` here. That tooltip earned its place
      // while it showed something the chip did NOT: up to 300 chars of the raw,
      // multi-line block content, against a chip showing only a 60-char first
      // line. Now that the store holds one normalised title and both renderers
      // render it verbatim, a floating tooltip would have rendered the chip's
      // own string back at it — a portal, a hover/focus state machine and an
      // extra subtree per chip, on every block-ref in every rendered block, for
      // zero additional information. What is still needed is the plain
      // "show me the part max-width cut off", which is exactly what the sibling
      // chips (`renderBlockLink`) already do with a native `title=`.
      title={title}
      {...deletedProps}
      {...interactiveProps}
    >
      {/* The `…` marker lives on this child, not the chip — the chip is
          `inline-flex` and `text-overflow` only applies to a block container
          (see `.block-ref-chip-label` in `src/index.css`). */}
      <span className="block-ref-chip-label">{title}</span>
    </span>
  )
}
