/**
 * TipTap editor configuration — minimal extension set per ADR-01.
 *
 * No starter-kit. Individual extensions only. Block-level Markdown
 * (headings, lists, blockquotes) is explicitly excluded.
 */

export type { BlockLinkOptions } from './extensions/block-link'
export { BlockLink } from './extensions/block-link'
export type { BlockLinkPickerOptions } from './extensions/block-link-picker'
export { BlockLinkPicker } from './extensions/block-link-picker'
export type { TagPickerOptions } from './extensions/tag-picker'
export { TagPicker } from './extensions/tag-picker'
export type { TagRefOptions } from './extensions/tag-ref'
export { TagRef } from './extensions/tag-ref'
export { parse, serialize } from './markdown-serializer'
export type { PickerItem } from './SuggestionList'
export { SuggestionList } from './SuggestionList'
export type { BlockKeyboardCallbacks } from './use-block-keyboard'
export { useBlockKeyboard } from './use-block-keyboard'
export type { RovingEditorHandle, RovingEditorOptions } from './use-roving-editor'
export { useRovingEditor } from './use-roving-editor'
