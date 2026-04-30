/**
 * Shared `addProseMirrorPlugins()` shell for the 5 picker extensions
 * (AtTagPicker, BlockLinkPicker, BlockRefPicker, SlashCommand,
 * PropertyPicker). Captures the duplicated `Suggestion(...)` boilerplate:
 *   - the items try/catch + logger.warn wrapper
 *   - the createSuggestionRenderer(displayName, pluginKey) wiring
 *   - the editor / pluginKey / char passthrough
 *
 * Per-picker variations (allowSpaces, allowedPrefixes, command body,
 * optional render override for slash-command's auto-execute timer) are
 * passed through cfg without defaulting — preserving each picker's
 * existing behaviour byte-equivalently.
 */

import type { Editor } from '@tiptap/core'
import type { PluginKey } from '@tiptap/pm/state'
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion'
import { logger } from '../../lib/logger'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

export interface PickerPluginConfig {
  /** Component name passed to `logger.warn` (e.g. 'BlockLinkPicker'). */
  loggerComponent: string
  /** Display name shown in the suggestion popup header (e.g. 'Block links'). */
  displayName: string
  /** Plugin key used by both Suggestion and the renderer. */
  pluginKey: PluginKey
  /** Trigger character(s) — '@', '[[', '((', '/', '::'. */
  char: string
  /** Whether the suggestion popup allows spaces in queries. Omit to use the TipTap default (false). */
  allowSpaces?: boolean
  /** Explicit allowedPrefixes list. Omit to use the TipTap default ([' ']). */
  allowedPrefixes?: string[] | null
  /** Editor reference (passed via this.editor at the call site). */
  editor: Editor
  /** Items callback wrapped by the helper with try/catch + logger.warn. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Picker-specific command body (insertion logic). */
  command: NonNullable<SuggestionOptions<PickerItem>['command']>
  /**
   * Optional render override. When omitted, the helper provides
   * `() => createSuggestionRenderer(displayName, pluginKey)`.
   * SlashCommand passes a custom render that wraps the base renderer
   * with auto-execute timer logic.
   */
  render?: SuggestionOptions<PickerItem>['render']
}

export function createPickerPlugin(cfg: PickerPluginConfig) {
  return Suggestion<PickerItem>({
    editor: cfg.editor,
    pluginKey: cfg.pluginKey,
    char: cfg.char,
    ...(cfg.allowSpaces !== undefined ? { allowSpaces: cfg.allowSpaces } : {}),
    ...(cfg.allowedPrefixes !== undefined ? { allowedPrefixes: cfg.allowedPrefixes } : {}),
    items: async ({ query }) => {
      try {
        return await cfg.items(query)
      } catch (err) {
        logger.warn(cfg.loggerComponent, 'items callback failed, returning empty', { query }, err)
        return []
      }
    },
    command: cfg.command,
    render: cfg.render ?? (() => createSuggestionRenderer(cfg.displayName, cfg.pluginKey)),
  })
}
