export type {
  ActiveBlockRow,
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  AggregateResult,
  AggregateSpec,
  BacklinkFilter,
  BacklinkGroup,
  BacklinkSort,
  BlockRow,
  CreateBlockSpec,
  DiffSpan,
  FilterExpr,
  FilterPrimitive,
  GroupedBacklinkResponse,
  GroupSpec,
  HistoryEntry,
  PageHeading,
  PageResponse,
  PageWithMetadataRow,
  PeerRef,
  PropertyDefinition,
  QueryGroup,
  SearchBlockRow,
  SortKey,
  SpaceRow,
  StatusInfo,
  TagCacheRow,
  VaultFile,
} from '@/lib/bindings'
export {
  LIST_BLOCKS_MAX,
  LIST_PROJECTED_AGENDA_MAX,
  listBlocksLimit,
  listProjectedAgendaLimit,
  PAGINATION_MAX,
  paginationLimit,
  SEARCH_BLOCKS_MAX,
  safeLimit,
  searchBlocksLimit,
} from '@/lib/safe-limit'
export { unwrap } from '@/lib/app-error'

// ---------------------------------------------------------------------------
// Domain re-export barrel (#2902). The IPC facade was split into per-domain
// modules under `./tauri/`; this file re-exports their full public surface so
// every existing `@/lib/tauri` import keeps working unchanged. Internal helpers
// (`toSpaceScope`, `requireActiveScope`) live in `./tauri/_shared` and are
// intentionally NOT re-exported (they were never public).
// ---------------------------------------------------------------------------
export * from '@/lib/tauri/blocks'
export * from '@/lib/tauri/pages'
export * from '@/lib/tauri/queries'
export * from '@/lib/tauri/search'
export * from '@/lib/tauri/links'
export * from '@/lib/tauri/history'
export * from '@/lib/tauri/properties'
export * from '@/lib/tauri/attachments'
export * from '@/lib/tauri/import'
export * from '@/lib/tauri/logging'
