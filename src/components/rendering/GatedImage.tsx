/**
 * GatedImage — privacy-gated image render shared by the editor node view and the
 * static (at-rest) renderer (#1492).
 *
 * External `http(s)` images are only fetched when the external-image policy +
 * per-host allowlist permit it (see `lib/external-image-policy`). When NOT
 * permitted, NO real `<img src>` is mounted — so no network request is made —
 * and a placeholder is shown instead:
 *   - `click` mode: the source domain + a "Load" button. Clicking adds the host
 *     to the allowlist (so this and future images from that host auto-load) and
 *     immediately loads this image.
 *   - `never` mode (or an unrecoverable malformed external src): a muted
 *     "external image blocked" placeholder with no Load affordance.
 *
 * Local / `data:` / `blob:` / `asset:` / same-origin srcs are never gated and
 * render the real `<img>` directly, preserving the #1434 broken-image fallback.
 */

import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useExternalImageAllowlist, useExternalImagePolicy } from '@/hooks/useExternalImagePolicy'
import { externalImageHost, shouldLoadExternalImage } from '@/lib/external-image-policy'

/** The labelled broken-image placeholder (shared, #1434 behaviour). */
function BrokenImage({ alt, src }: { alt: string; src: string }): React.ReactElement {
  return (
    <span
      className="image-broken inline-flex items-center gap-1 rounded border border-dashed border-input bg-muted px-1 text-sm text-muted-foreground align-middle"
      data-testid="image-broken"
      aria-label={alt.length > 0 ? alt : src}
      title={src}
    >
      <span aria-hidden="true">🖼️</span>
      <span>{alt.length > 0 ? alt : src}</span>
    </span>
  )
}

export interface GatedImageProps {
  src: string
  alt: string
  /** Extra classes for the real `<img>` (node view vs. static differ slightly). */
  imgClassName?: string
}

export function GatedImage({
  src,
  alt,
  imgClassName = 'image-rendered inline-block max-w-full align-middle',
}: GatedImageProps): React.ReactElement {
  const { t } = useTranslation()
  const { policy } = useExternalImagePolicy()
  const { allowlist, addHost } = useExternalImageAllowlist()
  const [failed, setFailed] = useState(false)

  // The exact external host, or null for local/same-origin/malformed.
  const host = externalImageHost(src)
  const allowed = shouldLoadExternalImage(src, policy, allowlist)

  // Broken-image fallback (#1434) once the real <img> errors out.
  if (failed) {
    return <BrokenImage alt={alt} src={src} />
  }

  if (allowed) {
    return (
      <img
        src={src}
        alt={alt}
        className={imgClassName}
        data-testid="image-rendered"
        // #1434 broken-image fallback (alt/URL placeholder) on load error.
        onError={() => setFailed(true)}
      />
    )
  }

  // Not allowed → privacy placeholder. `host === null` here means a malformed
  // external URL (genuine local/same-origin srcs are always allowed and handled
  // above), so there is no host to load — show the muted blocked state.
  const domainLabel = host ?? src
  // A Load affordance only makes sense in `click` mode WITH a real host to add.
  const showLoad = policy === 'click' && host !== null

  return (
    <span
      className="image-external-blocked inline-flex items-center gap-2 rounded border border-dashed border-input bg-muted px-2 py-1 text-sm text-muted-foreground align-middle"
      data-testid="image-external-blocked"
      // Announce as the external image with its domain so the placeholder has
      // context for assistive tech (mirrors the broken-image aria-label).
      aria-label={t('editor.image.externalBlockedAria', { domain: domainLabel })}
      title={src}
    >
      <span aria-hidden="true">🖼️</span>
      <span data-testid="image-external-domain" className="font-medium">
        {domainLabel}
      </span>
      {showLoad ? (
        <button
          type="button"
          className="rounded border border-input bg-background px-1.5 py-0.5 text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
          data-testid="image-load-button"
          // Add the exact host to the allowlist; the policy hook re-snapshots via
          // the synthetic storage event, re-rendering this image as allowed.
          onClick={() => addHost(host)}
        >
          {t('editor.image.loadButton')}
        </button>
      ) : (
        <span data-testid="image-external-blocked-note" className="text-xs italic">
          {t('editor.image.blockedNote')}
        </span>
      )}
    </span>
  )
}
