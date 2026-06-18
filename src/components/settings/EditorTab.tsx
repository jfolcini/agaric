/**
 * EditorTab — editor behaviour settings.
 *
 * Currently hosts the inline `:` emoji-picker toggle (#130). The preference
 * is stored in localStorage under `EMOJI_PICKER_ENABLED_KEY` and read live by
 * the editor's emoji extension, so toggling it takes effect on the next
 * keystroke without remounting the editor.
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { FormField } from '@/components/ui/form-field'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useExternalImageAllowlist, useExternalImagePolicy } from '@/hooks/useExternalImagePolicy'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { EMOJI_PICKER_ENABLED_KEY, TAB_INDENTS_BLOCKS_KEY } from '@/lib/editor-preferences'
import { type ExternalImagePolicy, isExternalImagePolicy } from '@/lib/external-image-policy'
import { notify } from '@/lib/notify'

export function EditorTab(): React.ReactElement {
  const { t } = useTranslation()
  const [emojiEnabled, setEmojiEnabled] = useLocalStoragePreference<boolean>(
    EMOJI_PICKER_ENABLED_KEY,
    true,
  )
  const [tabIndents, setTabIndents] = useLocalStoragePreference<boolean>(
    TAB_INDENTS_BLOCKS_KEY,
    true,
  )
  // #1492 — external-image load policy + the managed per-host allowlist.
  const { policy, setPolicy } = useExternalImagePolicy()
  const { allowlist, removeHost } = useExternalImageAllowlist()

  const handlePolicyChange = useCallback(
    (value: string) => {
      // The Select can only emit the values we render, but validate defensively.
      if (!isExternalImagePolicy(value)) return
      setPolicy(value satisfies ExternalImagePolicy)
      notify.success(t('settings.editor.externalImageUpdated'))
    },
    [setPolicy, t],
  )

  // Stable, sorted for a deterministic managed-domains list.
  const allowedHosts = [...allowlist].sort((a, b) => a.localeCompare(b))

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

      {/* #912 — accessibility opt-out: turn off Tab-indent to restore Tab as
          the focus-navigation key. Block indent stays on Ctrl/Cmd+Shift+Arrow. */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="tab-indent-toggle" muted={false}>
            {t('settings.editor.tabIndentLabel')}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">{t('settings.editor.tabIndentHelp')}</p>
        </div>
        <Switch
          id="tab-indent-toggle"
          checked={tabIndents}
          onCheckedChange={setTabIndents}
          aria-label={t('settings.editor.tabIndentLabel')}
          data-testid="tab-indent-toggle"
        />
      </div>

      {/* #1492 — external-image load policy (Always / Ask each time / Never).
          Privacy-first default is "click" (ask each time): external http(s)
          images show a placeholder until the user loads them; choosing Load
          remembers the domain. Local/data/asset/same-origin images are never
          gated. */}
      <FormField
        label={t('settings.editor.externalImageLabel')}
        htmlFor="external-image-policy-select"
        description={t('settings.editor.externalImageHelp')}
      >
        <Select value={policy} onValueChange={handlePolicyChange}>
          <SelectTrigger
            id="external-image-policy-select"
            aria-label={t('settings.editor.externalImageLabel')}
            data-testid="external-image-policy-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">{t('settings.editor.externalImageAlways')}</SelectItem>
            <SelectItem value="click">{t('settings.editor.externalImageClick')}</SelectItem>
            <SelectItem value="never">{t('settings.editor.externalImageNever')}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {/* Managed domains — hosts remembered via "Load" in Ask-each-time mode.
          Only surfaced when non-empty (keeps the tab clean for the common
          default). Removing a host stops its images auto-loading. */}
      {allowedHosts.length > 0 && (
        <div className="space-y-2" data-testid="external-image-allowlist">
          <Label muted={false}>{t('settings.editor.externalImageAllowedHosts')}</Label>
          <ul className="space-y-1">
            {allowedHosts.map((host) => (
              <li
                key={host}
                className="flex items-center justify-between gap-2 rounded border border-input bg-muted/40 px-2 py-1 text-sm"
              >
                <span className="truncate font-mono text-xs">{host}</span>
                <button
                  type="button"
                  className="rounded border border-input bg-background px-1.5 py-0.5 text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
                  data-testid={`external-image-remove-${host}`}
                  aria-label={t('settings.editor.externalImageRemoveHost', { host })}
                  onClick={() => removeHost(host)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
