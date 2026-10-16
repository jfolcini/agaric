/**
 * AppearanceTab — theme, font size, animation speed and tooltip delay selectors.
 *
 * Delegates each preference to its shared hook. The hooks are
 * localStorage-backed and re-read across windows via synthetic `storage`
 * events; App also mounts the hooks that apply app-wide DOM state at boot.
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { type FontSize, useFontSize } from '@/hooks/useFontSize'
import { type MotionPreference, useMotionPreference } from '@/hooks/useMotionPreference'
import { type ThemePreference, useTheme } from '@/hooks/useTheme'
import { type TooltipDelay, useTooltipDelay } from '@/hooks/useTooltipDelay'

/**
 * Theme select uses 'system' as the user-facing alias for the internal 'auto'
 * preference. All other values map 1:1 to ThemePreference.
 */
type ThemeSelectValue =
  | 'light'
  | 'dark'
  | 'system'
  | 'solarized-light'
  | 'solarized-dark'
  | 'dracula'
  | 'one-dark-pro'

// The trigger fills a phone row; from `sm` up it sits beside the label at a
// fixed width instead of stretching across the panel.
const SELECT_TRIGGER_WIDTH = 'sm:w-48'

/** Map the existing useTheme preference names to user-facing select values. */
function themeToSelect(theme: ThemePreference): ThemeSelectValue {
  if (theme === 'auto') return 'system'
  return theme
}

function selectToTheme(value: string): ThemePreference {
  if (value === 'system') return 'auto'
  return value as ThemePreference
}

export function AppearanceTab(): React.ReactElement {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { motion, setMotion } = useMotionPreference()
  const { tooltipDelay, setTooltipDelay } = useTooltipDelay()
  const { fontSize, setFontSize } = useFontSize()

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(selectToTheme(value))
    },
    [setTheme],
  )

  const handleFontSizeChange = useCallback(
    (value: string) => {
      setFontSize(value as FontSize)
    },
    [setFontSize],
  )

  const handleMotionChange = useCallback(
    (value: string) => {
      setMotion(value as MotionPreference)
    },
    [setMotion],
  )

  const handleTooltipDelayChange = useCallback(
    (value: string) => {
      setTooltipDelay(value as TooltipDelay)
    },
    [setTooltipDelay],
  )

  return (
    <Card>
      <CardContent className="space-y-6">
        {/* Theme selector */}
        <SettingRow label={t('settings.themeLabel')} controlId="theme-select">
          <Select value={themeToSelect(theme)} onValueChange={handleThemeChange}>
            <SelectTrigger id="theme-select" className={SELECT_TRIGGER_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{t('settings.themeLight')}</SelectItem>
              <SelectItem value="dark">{t('settings.themeDark')}</SelectItem>
              <SelectItem value="system">{t('settings.themeSystem')}</SelectItem>
              <SelectItem value="solarized-light">{t('settings.themeSolarizedLight')}</SelectItem>
              <SelectItem value="solarized-dark">{t('settings.themeSolarizedDark')}</SelectItem>
              <SelectItem value="dracula">{t('settings.themeDracula')}</SelectItem>
              <SelectItem value="one-dark-pro">{t('settings.themeOneDarkPro')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Font size selector */}
        <SettingRow label={t('settings.fontSizeLabel')} controlId="font-size-select">
          <Select value={fontSize} onValueChange={handleFontSizeChange}>
            <SelectTrigger id="font-size-select" className={SELECT_TRIGGER_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{t('settings.fontSizeSmall')}</SelectItem>
              <SelectItem value="medium">{t('settings.fontSizeMedium')}</SelectItem>
              <SelectItem value="large">{t('settings.fontSizeLarge')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Animation speed. A single knob over the design-system `--motion-scale`
            token (see `useMotionPreference`): System follows the OS reduced-motion
            setting, Fast halves every duration, Off disables animations. */}
        <SettingRow
          label={t('settings.motionLabel')}
          controlId="motion-select"
          description={t('settings.motionHelp')}
        >
          <Select value={motion} onValueChange={handleMotionChange}>
            <SelectTrigger
              id="motion-select"
              className={SELECT_TRIGGER_WIDTH}
              aria-describedby={settingDescriptionId('motion-select')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.motionSystem')}</SelectItem>
              <SelectItem value="full">{t('settings.motionFull')}</SelectItem>
              <SelectItem value="fast">{t('settings.motionFast')}</SelectItem>
              <SelectItem value="off">{t('settings.motionOff')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Tooltip delay (#2851). A separate axis from animation speed: how
            long to hover before a tooltip opens. Only affects the app-level
            baseline that most tooltips inherit — the deliberate per-surface
            deviations (sidebar, toolbars, gutter) are unaffected. */}
        <SettingRow
          label={t('settings.tooltipDelayLabel')}
          controlId="tooltip-delay-select"
          description={t('settings.tooltipDelayHelp')}
        >
          <Select value={tooltipDelay} onValueChange={handleTooltipDelayChange}>
            <SelectTrigger
              id="tooltip-delay-select"
              className={SELECT_TRIGGER_WIDTH}
              aria-describedby={settingDescriptionId('tooltip-delay-select')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="instant">{t('settings.tooltipDelayInstant')}</SelectItem>
              <SelectItem value="fast">{t('settings.tooltipDelayFast')}</SelectItem>
              <SelectItem value="default">{t('settings.tooltipDelayDefault')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </CardContent>
    </Card>
  )
}
