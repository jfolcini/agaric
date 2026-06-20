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
 *
 * An `attachment:<id>` ref (#1434, pasted/dropped inline image) is resolved here:
 * the attachment's bytes are read over IPC and wrapped in an object URL, which is
 * a local `blob:` src that loads directly (never gated, never networked). The
 * object URL is revoked when the src changes or the component unmounts.
 */

import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useExternalImageAllowlist, useExternalImagePolicy } from '@/hooks/useExternalImagePolicy'
import { isAttachmentRef, parseAttachmentRef } from '@/lib/attachment-ref'
import { externalImageHost, shouldLoadExternalImage } from '@/lib/external-image-policy'
import { readAttachment } from '@/lib/tauri'

/** Wrap raw bytes in a typed `Blob` (mime defaults to a generic octet-stream). */
function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  // Copy into a fresh, exactly-sized ArrayBuffer so the Blob never captures a
  // larger pooled buffer the Uint8Array might be a view into.
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Blob([copy], { type: mimeType || 'application/octet-stream' })
}

/**
 * Resolve an `attachment:<id>` ref to an object URL (`null` until loaded, or on
 * error). Reads the attachment bytes over IPC on mount / id-change and revokes
 * the previous object URL when the id changes or the component unmounts. For a
 * non-ref `src` this is inert and returns `null` so the caller uses `src` as-is.
 */
function useResolvedAttachmentSrc(src: string): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const id = parseAttachmentRef(src)
    if (id === null) {
      // Not an attachment ref — nothing to resolve; clear any stale state.
      setUrl(null)
      setError(false)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setUrl(null)
    setError(false)
    readAttachment(id)
      .then((bytes) => {
        if (cancelled) return
        // The mime type isn't carried in the ref; the browser sniffs the image
        // from the bytes, so a generic blob type is fine for <img>.
        objectUrl = URL.createObjectURL(bytesToBlob(bytes, ''))
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  return { url, error }
}

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

  // Resolve an `attachment:<id>` ref (#1434) to an object URL. For any other src
  // this is inert (`resolvedUrl === null`, `attachmentError === false`).
  const isAttachment = isAttachmentRef(src)
  const { url: resolvedUrl, error: attachmentError } = useResolvedAttachmentSrc(src)

  // Broken-image fallback (#1434) once the real <img> errors out, or the
  // attachment bytes failed to load.
  if (failed || (isAttachment && attachmentError)) {
    return <BrokenImage alt={alt} src={src} />
  }

  // Attachment ref: a trusted local image — never gated. Render the resolved
  // object URL once the bytes load; until then show the alt-labelled placeholder
  // (no <img src> is mounted, so no broken-image flash before the URL resolves).
  if (isAttachment) {
    if (resolvedUrl === null) {
      return <BrokenImage alt={alt} src={src} />
    }
    return (
      <img
        src={resolvedUrl}
        alt={alt}
        className={imgClassName}
        data-testid="image-rendered"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    )
  }

  // The exact external host, or null for local/same-origin/malformed.
  const host = externalImageHost(src)
  const allowed = shouldLoadExternalImage(src, policy, allowlist)

  if (allowed) {
    return (
      <img
        src={src}
        alt={alt}
        className={imgClassName}
        data-testid="image-rendered"
        // Defer offscreen fetches + decode off the main thread to cut layout
        // shift on image-heavy trees (#1642). Intrinsic dimensions aren't known
        // here (ImageNode.attrs carry only { alt, src }), so none are reserved.
        loading="lazy"
        decoding="async"
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
