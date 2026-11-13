/**
 * Android's file save (#6546): the helper every export, attachment and report
 * goes through on Android. A failed save must reject and toast no success, so
 * a caller cannot report a file that was never written.
 */

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { t } from '@/lib/i18n'
import { saveToAndroidDownloads } from '@/lib/platform/android-save'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('saveToAndroidDownloads', () => {
  it('sends the name, type and bytes, then names the file as the OS saved it', async () => {
    const saves: unknown[] = []
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        save_file_to_downloads: (args) => {
          saves.push(args)
          // The OS renames a file whose name is taken.
          return 'export (1).zip'
        },
      }),
    )

    await saveToAndroidDownloads(new Blob(['hi'], { type: 'application/zip' }), 'export.zip')

    expect(saves).toEqual([{ fileName: 'export.zip', mimeType: 'application/zip', bytes: 'aGk=' }])
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith(
      t('data.savedToDownloads', { fileName: 'export (1).zip' }),
    )
  })

  it('rejects and toasts no success when nothing was saved', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        save_file_to_downloads: () => Promise.reject({ kind: 'io', message: 'no space left' }),
      }),
    )

    await expect(saveToAndroidDownloads(new Blob(['hi']), 'export.zip')).rejects.toMatchObject({
      kind: 'io',
    })
    expect(toast.success).not.toHaveBeenCalled()
  })
})
