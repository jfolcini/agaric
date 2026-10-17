/**
 * Page mode's extensions (#5691): block mode's content nodes, marks, chips and
 * their pickers (`use-roving-editor.ts`), under page mode's own document and
 * keys. Block mode's behaviour that writes through its block store (the slash
 * menu, the `::` picker, checkbox and list-style input rules, block paste) is
 * left out: in page mode the document owns text and structure.
 */

import type { Extensions } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import HardBreak from '@tiptap/extension-hard-break'
import History from '@tiptap/extension-history'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Italic from '@tiptap/extension-italic'
import { BulletList } from '@tiptap/extension-list'
import ListItem from '@tiptap/extension-list-item'
import OrderedList from '@tiptap/extension-ordered-list'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import Text from '@tiptap/extension-text'

import { AtTagPicker } from '@/editor/extensions/at-tag-picker'
import { BlockLink } from '@/editor/extensions/block-link'
import { BlockLinkPicker } from '@/editor/extensions/block-link-picker'
import { BlockRef } from '@/editor/extensions/block-ref'
import { BlockRefPicker } from '@/editor/extensions/block-ref-picker'
import { CalloutBlockquote } from '@/editor/extensions/callout-blockquote'
import { ExternalLink } from '@/editor/extensions/external-link'
import { withFlankingShortcuts } from '@/editor/extensions/flanking-marks'
import { Image } from '@/editor/extensions/image'
import { MathBlock, MathInline } from '@/editor/extensions/math'
import { TagRef } from '@/editor/extensions/tag-ref'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import { TaskPaste } from '@/editor/extensions/task-paste'
import { Underline } from '@/editor/extensions/underline'
import { PageBlockIds } from '@/editor/page-mode/page-block-ids'
import { PageBlock, PageDocument } from '@/editor/page-mode/page-document'
import { PageKeys } from '@/editor/page-mode/page-keys'
import type { PickerItem } from '@/editor/SuggestionList'
import {
  CodeBlockWithShortcut,
  CodeWithShortcut,
  HeadingWithoutDefaultShortcuts,
  HighlightWithShortcut,
  StrikeWithShortcut,
} from '@/editor/use-roving-editor'
import { unresolvedBlockLabel, unresolvedBlockRefLabel } from '@/lib/block-title'
import { curatedLowlight } from '@/lib/lowlight-curated'

export interface PageModeExtensionOptions {
  resolveTagName: (id: string) => string
  resolveBlockTitle: (id: string) => string
  searchTags: (query: string) => Promise<PickerItem[]>
  searchPages: (query: string) => Promise<PickerItem[]>
  searchBlockRefs: (query: string) => Promise<PickerItem[]>
  onCreatePage: (label: string) => Promise<string>
  onCreateTag: (name: string) => Promise<string>
  /** Mints a new block's id; a test passes a deterministic one. */
  mintId?: () => string
}

export function pageModeExtensions(options: PageModeExtensionOptions): Extensions {
  return [
    PageDocument,
    PageBlock,
    TaskParagraph,
    Text,
    withFlankingShortcuts(Bold, ['**', '__']),
    withFlankingShortcuts(Italic, ['*', '_']),
    CodeWithShortcut,
    withFlankingShortcuts(StrikeWithShortcut, ['~~']),
    withFlankingShortcuts(HighlightWithShortcut, ['==']),
    Underline,
    CalloutBlockquote,
    OrderedList,
    BulletList,
    ListItem,
    HorizontalRule,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    CodeBlockWithShortcut.configure({ lowlight: curatedLowlight }),
    HeadingWithoutDefaultShortcuts.configure({ levels: [1, 2, 3, 4, 5, 6] }),
    HardBreak,
    History,
    ExternalLink,
    MathInline,
    MathBlock,
    Image,
    TagRef.configure({ resolveName: options.resolveTagName }),
    BlockLink.configure({ resolveTitle: options.resolveBlockTitle }),
    BlockRef.configure({
      // As block mode: a miss reads `(( id… ))`, not the page-link shape.
      resolveContent: (id: string) => {
        const resolved = options.resolveBlockTitle(id)
        return resolved === unresolvedBlockLabel(id) ? unresolvedBlockRefLabel(id) : resolved
      },
    }),
    AtTagPicker.configure({ items: options.searchTags, onCreate: options.onCreateTag }),
    BlockLinkPicker.configure({ items: options.searchPages, onCreate: options.onCreatePage }),
    BlockRefPicker.configure({ items: options.searchBlockRefs }),
    TaskPaste,
    PageBlockIds.configure(options.mintId === undefined ? {} : { mintId: options.mintId }),
    PageKeys,
  ]
}
