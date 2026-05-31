/**
 * EditorTab — editor behaviour settings.
 *
 * Currently hosts the inline `:` emoji-picker toggle (#130). The preference
 * is stored in localStorage under `EMOJI_PICKER_ENABLED_KEY` and read live by
 * the editor's emoji extension, so toggling it takes effect on the next
 * keystroke without remounting the editor.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { EMOJI_PICKER_ENABLED_KEY } from '@/lib/editor-preferences'

export function EditorTab(): React.ReactElement {
  const { t } = useTranslation()
  const [emojiEnabled, setEmojiEnabled] = useLocalStoragePreference<boolean>(
    EMOJI_PICKER_ENABLED_KEY,
    true,
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="emoji-picker-toggle" muted={false}>
            {t('settings.editor.emojiPickerLabel')}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            {t('settings.editor.emojiPickerHelp')}
          </p>
        </div>
        <Switch
          id="emoji-picker-toggle"
          checked={emojiEnabled}
          onCheckedChange={setEmojiEnabled}
          aria-label={t('settings.editor.emojiPickerLabel')}
          data-testid="emoji-picker-toggle"
        />
      </div>
    </div>
  )
}
