export type {
  ActiveBlockRow,
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  AggOp,
  AggregateColumn,
  AggregateResult,
  AggregateSpec,
  AggregateTarget,
  BacklinkFilter,
  BacklinkGroup,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  CompareOp,
  CreateBlockSpec,
  DateBucketUnit,
  DateField,
  DateRange,
  DeletePropertyResponse,
  DeleteResponse,
  DiffSpan,
  DiffTag,
  Draft,
  FilterExpr,
  FilterPrimitive,
  FlushAllDraftsResult,
  GroupedBacklinkResponse,
  GroupKey,
  GroupSpec,
  HistoryEntry,
  ImportProgressUpdate,
  MdnsStatus,
  MoveResponse,
  PageHeading,
  PageLink,
  PageLinksResponse,
  PageResponse,
  PageSort,
  PageSubtree,
  PageWithMetadataRow,
  PartitionedSearchResponse,
  PropertyDefinition,
  PurgeResponse,
  QueryGroup,
  QueryResultRow,
  RecoveryStatus,
  RestoreResponse,
  RestoreToOpResult,
  SearchBlockRow,
  SearchFilter,
  SortColumn,
  SortDir,
  SortKey,
  SortSource,
  SpaceId,
  SpaceRow,
  SpaceScope,
  StatusInfo,
  SyncProgressUpdate,
  TagCacheRow,
  TagExpr,
  TagResponse,
  TaskNotification,
  VaultFile,
  WithOps,
} from '@/lib/bindings'
export type { SafeLimit } from '@/lib/safe-limit'
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
export * from '@/lib/tauri/core'
export * from '@/lib/tauri/blocks'
export * from '@/lib/tauri/pages'
export * from '@/lib/tauri/queries'
export * from '@/lib/tauri/notifications'
export * from '@/lib/tauri/tags'
export * from '@/lib/tauri/search'
export * from '@/lib/tauri/links'
export * from '@/lib/tauri/history'
export * from '@/lib/tauri/properties'
export * from '@/lib/tauri/tasks'
export * from '@/lib/tauri/sync'
export * from '@/lib/tauri/attachments'
export * from '@/lib/tauri/import'
export * from '@/lib/tauri/drafts'
export * from '@/lib/tauri/logging'
export * from '@/lib/tauri/system'
