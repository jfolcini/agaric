import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { blobToBase64 } from '@/lib/file-utils'
import { t } from '@/lib/i18n'
import { readAttachment } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { isAndroid, isMac } from '@/lib/platform'

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

/**
 * Save `blob` as `filename` in the user's Downloads folder: the one path every
 * file save takes. Resolves once the save is handed over, with the name the
 * file has there where the backend wrote it (it differs when `filename` was
 * taken) and `filename` where the webview did; rejects when the save failed,
 * so a caller claims success only after it.
 *
 * - Android and macOS write through the backend. The Android WebView handles
 *   no `blob:` download (#6546), and WKWebView cancels a download no handler
 *   claims, of which the app registers none (#6652).
 * - Android shows no download of its own, so the save says where the file
 *   went, under the name the OS gave it.
 * - Elsewhere the webview downloads a transient anchor's `blob:` URL.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<string> {
  if (isAndroid() || isMac()) {
    const savedAs = unwrap(await commands.saveToDownloads(filename, await blobToBase64(blob)))
    if (isAndroid()) notify.success(t('data.savedToDownloads', { fileName: savedAs }))
    return savedAs
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // #2275: WebKitGTK can start the download after `click()` returns, so a
  // revoke on the next line races the fetch and can abort it.
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return filename
}

/** {@link saveBlob} for raw bytes. */
export function triggerDownload(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<string> {
  return saveBlob(bytesToBlob(bytes, mimeType), filename)
}

/**
 * Download the attachment an `[label](attachment:<id>)` link names under its
 * stored name, as the file chip saves a file it cannot preview. Never rejects:
 * a failure is logged and toasted.
 */
export async function openAttachmentLink(attachmentId: string): Promise<void> {
  try {
    const meta = unwrap(await commands.readAttachmentMeta(attachmentId))
    await triggerDownload(await readAttachment(attachmentId), meta.mime_type, meta.filename)
  } catch (err) {
    logger.warn('attachment-utils', 'attachment link download failed', { attachmentId }, err)
    notify.error(t('attachments.loadFailed'))
  }
}
