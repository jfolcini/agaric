/**
 * Android's file save (#6546). The WebView handles no `blob:` download, so
 * `downloadBlob` and `triggerDownload` hand every file to the
 * `save_file_to_downloads` command, which writes it into the phone's
 * Downloads folder (`src-tauri/src/commands/file_save.rs`).
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { blobToBase64 } from '@/lib/file-utils'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'

/**
 * Save `blob` to Downloads and say where it went, under the name the OS gave
 * it (a taken name gets a suffix). Rejects when nothing was saved, so a caller
 * reports success only after this resolves.
 */
export async function saveToAndroidDownloads(blob: Blob, fileName: string): Promise<void> {
  const savedAs = unwrap(
    await commands.saveFileToDownloads(fileName, blob.type, await blobToBase64(blob)),
  )
  notify.success(t('data.savedToDownloads', { fileName: savedAs }))
}
