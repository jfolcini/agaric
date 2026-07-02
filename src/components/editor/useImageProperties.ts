/**
 * useImageProperties — the image-property render concern of StaticBlock.
 *
 * Owns the per-block image width / alignment / caption that ride the same
 * property mechanism as `image_width` (setProperty/getProperty — no schema
 * migration) and hydrates them from the page-wide `BatchPropertiesProvider`
 * (or a single batched IPC fallback outside a provider).
 *
 * Returns the current values plus their setters so the resize toolbar can
 * optimistically update them while an edit round-trips.
 */

import { useEffect, useState } from 'react'

import {
  DEFAULT_IMAGE_ALIGNMENT,
  type ImageAlignment,
} from '@/components/editor-toolbar/ImageResizeToolbar'
import { useBatchProperties } from '@/hooks/useBatchProperties'
import { logger } from '@/lib/logger'
import { getBatchProperties, type PropertyRow } from '@/lib/tauri'

export interface ImageProperties {
  imageWidth: string
  imageAlignment: ImageAlignment
  imageCaption: string
  setImageWidth: (width: string) => void
  setImageAlignment: (alignment: ImageAlignment) => void
  setImageCaption: (caption: string) => void
}

export function useImageProperties(blockId: string, hasImageAttachments: boolean): ImageProperties {
  // Image resize / alignment / caption state (#212 items 3 & 4). Alignment and
  // caption ride the same per-block property mechanism as `image_width`
  // (setProperty/getProperty) — no schema migration.
  const [imageWidth, setImageWidth] = useState('100')
  const [imageAlignment, setImageAlignment] = useState<ImageAlignment>(DEFAULT_IMAGE_ALIGNMENT)
  const [imageCaption, setImageCaption] = useState('')

  // #2270 — image_width / image_alignment / image_caption come from the
  // page-wide `BatchPropertiesProvider` mounted at the BlockTree level
  // (mirrors the `useBatchAttachments` path), so a gallery /
  // journal week/month view no longer fires one `getBatchProperties([blockId])`
  // IPC per image block — the page-wide batch already carries these rows.
  //
  // Freshness: the provider refetches whenever the `block:properties-changed`
  // event fires (its `invalidationKey`) or the space switches, so an edit to
  // width/alignment/caption re-syncs here with the same freshness as the old
  // per-block mount fetch — a caption that arrives later still propagates as a
  // fresh `imageCaption` prop update to AttachmentRenderer (#2214).
  //
  // Outside a provider (unit tests, isolated renders — StaticBlock's only
  // production mount is under BlockTree, which mounts the provider), fall back
  // to the single-block batched IPC (#543: one call for all three properties).
  const batchProperties = useBatchProperties()
  useEffect(() => {
    if (!hasImageAttachments) return

    const applyImageProps = (rows: readonly PropertyRow[]): void => {
      const byKey = new Map(rows.map((r) => [r.key, r]))
      const width = byKey.get('image_width')?.value_text
      if (width) setImageWidth(width)
      const align = byKey.get('image_alignment')?.value_text
      if (align === 'left' || align === 'center' || align === 'right') {
        setImageAlignment(align)
      }
      const caption = byKey.get('image_caption')?.value_text
      if (caption != null) setImageCaption(caption)
    }

    // Provider path: read from the shared page-wide batch. Skip while the
    // batch is (re)fetching so a mid-refetch render can't clobber an
    // optimistic width/alignment/caption edit with stale rows; the effect
    // re-runs (the context value identity changes) once fresh data lands.
    if (batchProperties) {
      if (batchProperties.loading) return
      const rows = batchProperties.get(blockId)
      if (rows == null) return
      applyImageProps(rows)
      return
    }

    // Fallback path (no provider): one batched IPC for all three image
    // properties instead of three single-key getProperty round-trips.
    let cancelled = false
    getBatchProperties([blockId])
      .then((byBlock) => {
        if (cancelled) return
        applyImageProps(byBlock[blockId] ?? [])
      })
      .catch((err) => {
        logger.warn('StaticBlock', 'image property batch fetch failed', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [blockId, hasImageAttachments, batchProperties])

  return {
    imageWidth,
    imageAlignment,
    imageCaption,
    setImageWidth,
    setImageAlignment,
    setImageCaption,
  }
}
