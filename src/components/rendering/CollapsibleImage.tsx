/**
 * CollapsibleImage — an image the reader can fold down to a labelled chip (#4711).
 *
 * Collapse is a VIEW preference, not document content. The block's markdown
 * stays `![alt](url)`, so nothing is appended to the op log, markdown export is
 * unchanged, and two devices can never disagree about it. The state is one
 * registry preference (`PREFERENCES.imageCollapse`, a list of collapsed image keys),
 * which is what makes it survive a reload AND hold across the two surfaces the
 * same image renders on: the roving TipTap node view on the focused block
 * (`ImageNodeView`) and the static renderer everywhere else
 * (`RichContentRenderer/marks/image`). Per invariant 4 only one block is ever the
 * editor, so state kept inside the node view would vanish the moment focus left.
 *
 * `usePreference` (rather than `EmbedContainer`'s `useState` + `readPreference`
 * seed) for the same reason: it re-reads on the registry's change broadcast, so
 * every mounted copy of one image folds together instead of drifting apart.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { GatedImage } from '@/components/rendering/GatedImage'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { imageCollapseKey, PREFERENCES, usePreference } from '@/lib/preferences'
import { cn } from '@/lib/utils'

/** Longest label the collapsed chip shows; a `data:` src has no short name. */
const MAX_LABEL_CHARS = 40

/**
 * Identifying text for the collapsed chip: the alt, else the src's filename,
 * else the src — capped, because a `data:` src is unbounded.
 *
 * A `data:` src reaches the chip through the FILENAME branch, not the src one:
 * `'data:image/png;base64,AAA…'.split('/').pop()` is `'png;base64,AAA…'`, which
 * is why the cap has to sit outside the branches. The bare-src branch is for a
 * src with no path segment left to take — one ending in `/`, or empty.
 */
function collapsedLabel(alt: string, src: string): string {
  const filename = src.split(/[?#]/)[0]?.split('/').pop()?.trim() ?? ''
  const raw = alt.trim() !== '' ? alt.trim() : filename !== '' ? filename : src
  return raw.length > MAX_LABEL_CHARS ? `${raw.slice(0, MAX_LABEL_CHARS)}…` : raw
}

export interface CollapsibleImageProps {
  src: string
  alt: string
  /** Extra classes for the real `<img>`; forwarded to `GatedImage`. */
  imgClassName?: string
}

export function CollapsibleImage({
  src,
  alt,
  imgClassName,
}: CollapsibleImageProps): React.ReactElement {
  const { t } = useTranslation()
  const [collapsedKeys, setCollapsedKeys] = usePreference(PREFERENCES.imageCollapse)
  // A digest, never the src: a pasted screenshot's `data:` src is megabytes,
  // and the stored list has to stay inside the origin's quota (#4864).
  const key = imageCollapseKey(src)
  const collapsed = collapsedKeys.includes(key)
  const label = collapsedLabel(alt, src)

  // Folding is a view action on the image, never on whatever contains it. Every
  // surface that renders block content interactively wraps the row in its own
  // click and Enter/Space handler — agenda and Unfinished tasks navigate to the
  // block, the outline drops it into edit mode — so the toggle stops both, the
  // way `blockLinkProps` and the `AttachmentRenderer` buttons already do.
  const toggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setCollapsedKeys((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
      )
    },
    [setCollapsedKeys, key],
  )

  // No `preventDefault`: the button's native Enter/Space activation is what
  // fires the click above.
  const stopActivationKeys = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
    }
  }, [])

  return (
    <span className="group/image inline-flex max-w-full items-start gap-0.5 align-middle">
      <button
        type="button"
        className={cn(
          'shrink-0 rounded-sm p-0.5 text-muted-foreground transition-opacity hover:text-foreground focus-ring-visible touch-target',
          // An EXPANDED image needs no at-rest cue — the image itself is the
          // state, so a permanent chevron beside every image is just noise
          // (#1243's rule for the block gutter). It reveals on hover / focus.
          // Collapsed, the chevron is the only affordance there is, so it stays.
          // Coarse pointers have no hover, so they always get it.
          !collapsed &&
            'opacity-0 group-hover/image:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100',
        )}
        data-testid="image-collapse-toggle"
        aria-expanded={!collapsed}
        aria-label={
          collapsed
            ? t('editor.image.expand', { name: label })
            : t('editor.image.collapse', { name: label })
        }
        // preventDefault on mousedown so clicking the toggle does not blur the
        // ProseMirror editor — a blur flushes the block and unmounts the node
        // view mid-click, swallowing it (#1498, and the Mermaid toggle #1438).
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        onKeyDown={stopActivationKeys}
      >
        <ChevronToggle isExpanded={!collapsed} size="md" solidWhenCollapsed />
      </button>
      {collapsed ? (
        <span
          className="rounded border border-dashed border-input bg-muted px-1 text-sm text-muted-foreground"
          data-testid="image-collapsed-label"
        >
          {label}
        </span>
      ) : (
        <GatedImage src={src} alt={alt} {...(imgClassName === undefined ? {} : { imgClassName })} />
      )}
    </span>
  )
}
