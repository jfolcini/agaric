import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { readAttachment } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

/** Format bytes into a human-readable size string. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Wrap raw attachment bytes in a typed `Blob`.
 *
 * `readAttachment` returns `Uint8Array<ArrayBufferLike>` (the buffer generic
 * TypeScript 5.7+ tracks). `BlobPart` requires `Uint8Array<ArrayBuffer>`, so
 * we re-wrap into a fresh ArrayBuffer-backed view. The copy is negligible
 * relative to the IPC round-trip that produced the bytes.
 */
export function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type: mimeType })
}

/** Trigger a browser download of `bytes` as `filename` via a transient anchor. */
export function triggerDownload(bytes: Uint8Array, mimeType: string, filename: string): void {
  const url = URL.createObjectURL(bytesToBlob(bytes, mimeType))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // #2275 — defer the revoke to a later tick. On WebKitGTK (Linux Tauri) and
  // WKWebView (macOS Tauri) the download can start asynchronously after
  // `click()`, so revoking the object URL on the next synchronous line races
  // the fetch and can abort the download. A 0ms timeout lets the browser pick
  // up the URL before it is freed — the standard blob-download pattern.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Download the attachment an `[label](attachment:<id>)` link names under its
 * stored name, as the file chip saves a file it cannot preview. Never rejects:
 * a failure is logged and toasted.
 */
export async function openAttachmentLink(attachmentId: string): Promise<void> {
  try {
    const meta = unwrap(await commands.readAttachmentMeta(attachmentId))
    triggerDownload(await readAttachment(attachmentId), meta.mime_type, meta.filename)
  } catch (err) {
    logger.warn('attachment-utils', 'attachment link download failed', { attachmentId }, err)
    notify.error(t('attachments.loadFailed'))
  }
}
