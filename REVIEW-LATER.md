# Review Later

Items flagged during development that need revisiting. Organized by section with cost estimates.

> **Do not add "Resolved" sections to this file.** When an item is resolved, remove it
> entirely (table row + detail section). Do NOT record the removal anywhere in this file.

> **No historical references.** This file tracks only open items. No session logs,
> no "resolved in session X" notes, no reclassification history, no audit narratives.
> When an item is resolved, delete it completely. When an item is reclassified, update
> it in place. The git history is the audit trail — this file is not a changelog.
> Session activity is tracked separately in `SESSION-LOG.md`.

**Cost key:** S = <2h, M = 2-8h, L = 8h+

---

## Summary

41 open items — 38 planned work (FEAT/MAINT/PERF/PUB) + 3 UX (UX-10, UX-11, UX-12). All frontend test-quality items closed. All five LOW backend cleanup batches (MAINT-148..152) closed. **All INFO/nits closed (last 5 in session 547).**

Previously resolved: 769+ items across 514 sessions (per SESSION-LOG.md unique session count; latest is session 547).

> **The "Backend Code Review" block near the end of this file (starting at `## Backend Code Review (Confirmed Findings) — Appended 2026-04-25`) is a large production-code review from a previous session. All 12 backend test-quality items (TEST-40..TEST-51) are now closed; the 5 remaining frontend test-quality items (TEST-56, TEST-61..64) closed in session 516.**

| ID | Section | Title | Cost |
|----|---------|-------|------|
| FEAT-3 | FEAT | Spaces — parent / umbrella (Phases 1 + 2 + 3 shipped; Phases 4–11 split into FEAT-3p4..FEAT-3p11) | S |
| FEAT-3p4 | FEAT | Spaces Phase 4: agenda / graph / backlinks / tags / properties scoping (+ promote `space_id` to required on `list_blocks` / `search_blocks`, page-membership check in `get_page_inner`, per-space `currentView`) | L |
| FEAT-3p9 | FEAT | Spaces Phase 9: per-space external integrations — per-space GCal calendar IDs / OAuth / push pipeline + space-name prefix on OS notifications (FEAT-11 coupling) | L |
| FEAT-4 | FEAT | Agent access: expose notes to external agents via an MCP server — parent / umbrella | L |
| FEAT-4i | FEAT | MCP v3 — Mobile (HTTPS/LAN via mTLS reuse from `sync_cert.rs`, agent-pairing flow) — DEFERRED pending v2 | L |
| FEAT-5 | FEAT | Google Calendar daily-agenda digest push (Agaric → dedicated GCal calendar) — parent / umbrella | L |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L |
| MAINT-111 | MAINT | Spike `rmcp` (official Rust MCP SDK) vs the hand-rolled JSON-RPC 2.0 dispatch in `mcp/server.rs` (~492 LOC of framing + `make_success` / `make_error` / `parse_request` / method-dispatch boilerplate); keep existing `ToolRegistry` + activity-feed if the adapter stays thin | M |
| MAINT-113 | MAINT | `ConflictFreeBlockId` newtype to lift invariant #9 (`is_conflict = 0` + `depth < 100` in every recursive CTE over `blocks`) into the type system — 220 `is_conflict = 0` SQL occurrences across 70 files. LOW-priority refactor for elegance, not correctness; the convention + review + documented invariant are already working. Do NOT do on a deadline. | L |
| MAINT-114 | MAINT | Audit `.github/workflows/` (4 files — `ci.yml`, `_validate.yml`, `release.yml`, `release-tag.yml`) for consolidation. Minimum wins likely 4 → 3 (fold `release-tag.yml` into `release.yml` as `workflow_dispatch`); full 4 → 2 (validate + release) probably not cleanly achievable without losing the per-push-vs-per-tag split. Spike first, commit only if the merged file is not worse than the pair. | S–M |
| MAINT-116 | MAINT | `useBlockSlashCommands.applyContentEdit` at `src/hooks/useBlockSlashCommands.ts:131-145` bypasses `pageStore.edit()` and omits `notifyUndoNewAction`, so heading / callout / numbered-list / divider slash commands silently leave the redo stack uncleared. Fix as part of adding a `setBlockProperty` action to `src/stores/page-blocks.ts` — also collapses 8 per-hook `pageStore.setState(...)` + rollback + `useUndoStore.getState().onNewAction(rootParentId)` copies across `useBlockProperties`, `useBlockSlashCommands`, `useBlockDatePicker`, `useCheckboxSyntax`. | S+M |
| MAINT-118 | MAINT | Block-surface prop drilling — `BlockListRenderer` / `SortableBlockWrapper` / `SortableBlock` carry 33 / 32 / 32 props each with **14 verbatim-shared callbacks** (`onNavigate` … `onSelect`) + **4 verbatim-shared resolvers**. Deliver via `PageBlockContext`-style provider + 3 hooks (`useBlockActions`, `useBlockResolvers`, `useBlockState`). Kills the memoisation lost to callback identity churn and unblocks every "add a new block action" ticket. | M |
| MAINT-119 | MAINT | Decompose `src/components/JournalPage.tsx` (728L) — extract `GlobalDateControls` / `JournalControls` to sibling files (currently inlined), extract `useCalendarPageDates()` hook that eliminates a **byte-identical** `listBlocks({blockType:'page',limit:500})` fetch at L356-369 ≡ L490-503 (runs twice on mount today), and extract `useJournalBlockCreation()` for the page-create + template-load + block-insert flow. Target ≤300 lines. | M |
| MAINT-120 | MAINT | `useIpcCommand<T>(command, options?)` hook to collapse the status-load + optimistic-update + revert + `logger.error` + `toast.error` pattern repeated verbatim across `GoogleCalendarSettingsTab`, `AgentAccessSettingsTab`, `DeviceManagement`, `BugReportDialog`, `PairingDialog`. Returns `{ execute, loading, error }`. | M |
| MAINT-122 | MAINT | Extract `createSpaceSubscriber(onChange)` helper + `useTauriEventListener(eventName, handler)` hook — the per-space-switch subscriber is duplicated nearly verbatim across `src/stores/navigation.ts:509-549` (41L) ≡ `journal.ts:187-256` (70L) ≡ `recent-pages.ts:140-168` (29L) (same `let prevSpaceKey` + `newKey = state.currentSpaceId ?? LEGACY_SPACE_KEY` + first-fire-seeds-on-undefined pattern). Tauri `listen()` + cleanup boilerplate also duplicated across `useSyncEvents` (×3 `.then/.catch` chains), `useDeepLinkRouter.ts:141-156` (file-local helper), `useBlockPropertyEvents.ts:40-60` (4th shape). | M |
| MAINT-123 | MAINT | Mock drift — `trash_descendant_counts` is invoked by `TrashView.tsx` via `src/lib/tauri.ts:133` but is missing from the `HANDLERS` map in `src/lib/tauri-mock/handlers.ts`. Also type `HANDLERS: Record<string, Handler>` against `bindings.ts` command names so the compiler catches this drift (today it is only diff-able by hand). Unlocks compile-time mock-drift detection for future commands. | S |
| MAINT-124 | MAINT | Collapse `src/App.tsx` (1436L) — 20+ effects for independent concerns, keyboard shortcut logic scattered across 5 separate effects (journal / global / space / tab / close-overlays), sidebar tree inlined at L1159-1394 (236L). Extract `useAppKeyboardShortcuts()` (5 effects → 1), `useAppDialogs()`, `<ViewDispatcher>`, `<AppShell>` (sidebar header / menu / footer + main content). Same commit fixes the silent `.catch(() => {})` triplet at `App.tsx:935-939` (`w.unminimize`, `w.show`, `w.setFocus` — outer `try/catch` does not trap because each `.catch` resolves the rejected promise to `undefined`) and standardizes 4 different async styles used in the file. Target ≤500 lines. | L |
| MAINT-125 | MAINT | `src/lib/tauri.ts` (1276L) hand-writes `invoke('<str>', ...)` wrappers for commands already typed by `src/lib/bindings.ts` (873L, auto-generated by Tauri Specta). Every new backend command is added in two places; renames drift silently. Stage migration in batches of ~10 wrappers that delegate to typed `commands.*` from `bindings.ts`, keeping the public surface stable. Pairs with MAINT-123 (typed `HANDLERS`) for end-to-end compile-time mock-drift detection. | L |
| MAINT-126 | MAINT | Split `src/lib/i18n.ts` (2351L single `en` resource, 800+ keys) by namespace (`common.ts`, `agenda.ts`, `editor.ts`, `settings.ts`, …). Do NOT add unused locales — `lng: 'en'` and `fallbackLng: 'en'` stay. Purely a readability / merge-conflict reduction. | M |
| MAINT-127 | MAINT | God-file decomposition (libs + stores): `src/stores/page-blocks.ts` (718L) — extract pure tree algorithms (`planSplit`, `computeIndentedBlocks`, `findPrevSiblingAt`, `midpointPosition` at L116-277) to `src/lib/block-tree-ops.ts`, factory stays ≤500; `src/stores/navigation.ts` (549L) — tab engine (`tabs`, `tabsBySpace`, `switchTab`, `openInNewTab`, `closeTab`, `selectTabsForSpace`, …) has drifted in from an unrelated concern, move to `src/stores/tabs.ts`; `src/lib/keyboard-config.ts` (740L) — split into 4 files by concern (catalog L17-549, normalise+match L555-658, storage L661-719, conflict detection L721); `src/hooks/useGraphSimulation.ts` (716L) — 9 banner-comment sections at L39/58/112/278/325/361/516/603/617 mark the seams (`useGraphZoom`, `useGraphWorkerSimulation`, `useGraphRenderElements`). | L |
| MAINT-128 | MAINT | God-component decomposition batch — `PageBrowser.tsx` (961L → ~300), `BlockTree.tsx` (899L, extract `useBlockLinkResolve` / `useBlockPropertiesBatch` / `useBlockNavigateToLink`), `TrashView.tsx` (788L), `ConflictList.tsx` (737L — also removes direct DOM-mutation anti-pattern at L287-300 where `item.setAttribute('role','option')` is called from a `useEffect`), `SettingsView.tsx` (620L → extract 9 tab panels to `src/components/settings/*.tsx` + lift `AutostartRow` / `QuickCaptureRow`), `HistoryView.tsx` (528L → `useHistorySelection` + `useHistoryKeyboardNav` + `HistoryListView`), `PropertyRowEditor.tsx` (539L — dispatch by `def.value_type`; deletes the `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L85), `SortableBlock.tsx` (469L — `useAttachmentCount` / `usePropertyDefForEdit` / `useBlockContextMenu`), `backlink-filter/AddFilterRow.tsx` (556L, child 2.5× its parent). Do NOT try to land in one PR — stagger per file. | L |
| MAINT-129 | MAINT | Duplication cleanup batch — **byte-identical** pairs to delete: `renderKeys()` at `KeyboardSettingsTab.tsx:23-43` ≡ `KeyboardShortcuts.tsx:68-88` (extract to `src/lib/render-keyboard-shortcut.tsx`); `formatSize` at `AttachmentList.tsx:26-30` ≡ `src/lib/attachment-utils.ts:22-26`; `MimeIcon` / `AttachmentMimeIcon` map duplicated between `AttachmentList.tsx:49-57` and `AttachmentRenderer.tsx:9-17`; `dueDateColor` at `BlockInlineControls.tsx:35-41` ≡ `AgendaResults.tsx:68-72`; `formatDateISO` in `BlockListItem.tsx:65-70` duplicates `src/lib/date-utils.formatDate`; `relativeTime` in `AttachmentList.tsx:32-46` (also hardcodes English) duplicates `src/lib/format-relative-time.ts`. **Near-identical** pairs: `handleMergeWithPrev` L226-296 ≡ `handleMergeById` L298-361 in `useBlockKeyboardHandlers.ts` (~70L of duplicated revert logic); 4 fetch-filter-extractUlid-batchResolve-merge effects in `useDuePanelData.ts` (L167-214 / L218-280 / L283-354 / L357-430); focus-ring + scroll-into-view + dep-reset triad in 6 list views (`LinkedReferences`, `UnlinkedReferences`, `HistoryView`, `PageBrowser`, `TrashView`, `ConflictList` — all carry the same `biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset`) — extract `useFocusedRowEffect`; `useLocalStoragePreference<T>(key, default)` hook to unify 3 inconsistent read/write/catch variants (`DuePanel.tsx:57-86`, `useAgendaPreferences.ts:16-34`, `DeadlineWarningSection`). | M |
| MAINT-130 | MAINT | Dead code + naming + convention-drift batch — dead: `EditableBlock.tsx:293` stray `;('EditableBlock')` statement; stale `export { getAssetUrl }` at `StaticBlock.tsx:32` (0 production importers); stale `export { EDITOR_PORTAL_SELECTORS }` at `EditableBlock.tsx:28` (0 production importers — also fix `src/__tests__/AGENTS.md:616` doc drift); `PRIORITY_DISPLAY` at `BlockInlineControls.tsx:29` (legacy, only own tests import); `StaticBlock.tsx:33` back-compat re-export of `renderRichContent` (8 production importers should import from canonical path); `QueryResult.tsx:21-26` dead re-exports; partial dead at `AgendaFilterBuilder.tsx:27-36` (keep only `AgendaSortGroupControls` which `journal/AgendaView.tsx:13` consumes); `src/editor/types.ts` — 22 of 23 builder functions are only imported by tests (move to `__tests__/builders.ts`). Naming / collision: `src/components/BlockContextMenu.tsx` (floating menu) vs `src/components/block-tree/BlockContextMenu.tsx` (batch toolbar) same symbol name, different components (rename one); `src/hooks/use-mobile.ts` is the sole kebab-case hook file among 56 camelCase siblings (7 non-test importers; rename to `useIsMobile.ts`); `.helpers.ts` suffix on 3 files — adopt or drop consistently. Convention drift: `PageTitleEditor.tsx:21-25` and `TemplatesView.tsx:220-225` use `[...].join(' ')` instead of `cn()`; `SpaceManageDialog.tsx:652` uses bare `overflow-y-auto` on DialogContent instead of `ScrollArea` (lone straggler after UX-208 migration); `TemplatesView`, `PropertyDefinitionsList`, `SourcePageFilter` hand-roll `<Input className="pl-9">` + absolute `<Search>` instead of the existing `SearchInput` primitive used by `TrashView` / `TagFilterPanel` / `AddFilterRow`; direct DOM mutation from `useEffect` in `ConflictList.tsx:287-300` / `LinkedReferences.tsx:251-265` / `UnlinkedReferences.tsx:250-265` (React can overwrite on re-render). Create `<ConfirmDestructiveAction>` wrapper over `AlertDialog` and migrate `PairingDialog` / `GoogleCalendarSettingsTab` / `AgentAccessSettingsTab` / `DeviceManagement` (three different confirm patterns today; last two have none on destructive actions). Extract `useStarredPages` hook so `PageBrowser` / `PageHeader` stop calling `toggleStarred` + `starredRevision` counter directly. `BlockRefPicker` is the odd picker out among 5 — add `addInputRule` + `onCreate` + module-augmented `Commands` to match siblings, AND fix `use-roving-editor.ts:280-281 / 340-342` Pattern-C ref plumbing (reads `.current` at configure time, defeats the ref) — migrate to wrapper-closure pattern that `TagRef.configure` at L309-313 uses. Factor out `createPickerPlugin(cfg)` for the ~50-70 LOC/file shared `addProseMirrorPlugins` shell across the 5 pickers (keep per-picker `addInputRules` separate). | M |
| MAINT-131 | MAINT | Block-surface Tauri coupling — 8 presentational components in `src/components/` import functions from `src/lib/tauri` directly (`StaticBlock`, `EditableBlock`, `SortableBlock`, `BlockListItem`, `BlockPropertyEditor`, `BlockPropertyDrawer`, `ImageResizeToolbar`, `LinkEditPopover`). Notable double-IPC: `SortableBlock.tsx:155` calls `listAttachments(blockId)` AND `StaticBlock` via `useBlockAttachments` also calls `listAttachments` for every visible block (1 IPC → 2 IPCs per block row on the page). Add backend `get_batch_attachment_counts(block_ids)` (mirrors the existing `json_each`-backed batch patterns in `fts.rs` / `backlink/query.rs`), wrap per-IPC calls in hooks (`usePropertySave` already exists; add `useBlockReschedule`, `useLinkMetadata`). Prevents isolated rendering (Storybook, unit tests w/o full mocks) too. | L |
| MAINT-132 | MAINT | Consolidate hand-written recursive CTEs. Ancestor walks at `commands/blocks/move_ops.rs:93-109` (cycle detection) + `commands/blocks/crud.rs:99-110` (depth check) and descendant walks at `commands/history.rs:51-64` / `:72-81` (DeleteBlock/RestoreBlock cascades) are still inline. `block_descendants.rs` macros cover descendant walks but not ancestors, and history.rs is not on the documented exception list at `block_descendants.rs:36-38`. Every hand-written CTE risks forgetting invariant #9 (`is_conflict = 0` + `depth < 100`). Extend the macro family to cover ancestor walks + `find_lca` chain-walking; migrate history.rs to the existing `descendants_cte_*!()` macros. | M |
| MAINT-137 | MAINT | Extract `#[cfg(test)]` mega-blocks to sibling `tests.rs` files. Production / test line counts: `mcp/server.rs` 3053 total / ~915 prod, `mcp/tools_ro.rs` 2138 / ~645, `mcp/tools_rw.rs` 1189 / ~449, `sync_files.rs` 2393 / ~720. Mechanical move; no production refactor required. Matches the already-established pattern in `sync_daemon/`, `sync_protocol/`, `sync_net/`. Immediately reduces scan time on the largest backend files. Do in one commit per file so CI cache invalidation stays bounded. | S–M |
| MAINT-139 | MAINT | Collapse the `GcalClient` trait + `GcalApiAdapter` in `gcal_push/connector.rs:97-212`. The ~115 lines of forwarders exist only so `MockGcalClient` can be substituted in tests, but `GcalApi` already supports a configurable base URL (used by `wiremock` in existing tests), and the parallel API has already drifted (`patch_event` returns `EventResponse` in `api.rs` but `()` through the adapter). Either (a) retire the trait+adapter and test `GcalApi` directly against `wiremock`, or (b) make `GcalApi` itself `impl GcalClient`. Also eliminates the 40-line `ClientAdapter` nested trait impl inside `run_task_loop` (`connector.rs:957-996`) that only exists to paper over generics vs trait object. | M |
| MAINT-142 | MAINT | Split `tag_inheritance.rs` (~1233L) into `tag_inheritance/mod.rs` (dispatcher) + `incremental.rs` + `rebuild.rs` + `tests.rs` — matches the pattern used by sibling modules. The file documents `apply_op_tag_inheritance` as "the" single entry point but 7 other `pub async fn` are also callable; demote helpers to `pub(crate)` as part of the split. Macros file (`tag_inheritance_macros.rs`) is a sibling and stays where it is. | M |
| MAINT-159 | MAINT | `scripts/check-ipc-error-path.mjs` only enforces error-path coverage for `src/components/*.tsx` top-level files (`files = "^src/components/([^/]+\\.tsx\|...)$"` in `prek.toml:189`). Subdirectory components in `src/components/agent-access/`, `src/components/journal/`, `src/components/block-tree/`, `src/components/backlink-filter/`, and the new `src/components/settings/` (after MAINT-128) are out of scope. The script header itself documents this as a "HARD-NARROWED" scope with a deferred FOLLOW-UP. Subdirectory components import from `@/lib/tauri` and may have no error-path test today — the gate doesn't fire. Fix: walk `src/components/**/*.tsx` recursively (update both the script's file walk and the prek `files` regex), then address whatever new gaps the recursive walk surfaces. Land AFTER MAINT-128 so the new subdirectories from the god-component split are in place. | S |
| MAINT-162 | MAINT | ARIA role re-evaluation for list views — `nested-interactive: { enabled: false }` at ~20 axe sites (`PageBrowser.test.tsx`, `TrashView.test.tsx`, `ConflictList.test.tsx`, `HistoryListItem.test.tsx`, `StaticBlock.test.tsx` ×7, `TagFilterPanel.test.tsx`) and `aria-required-children: { enabled: false }` at `PageBrowser.test.tsx:2187` (FEAT-14 mixed-mode list with options + tree-button rows) both paper over the same root cause: `role="listbox"` + `role="option"` on rows that contain action buttons (star, delete, navigate). Per WAI-ARIA APG, options must be atomic and non-interactive — the suppressions silence a real screen-reader-broken state. Correct primitive is `role="grid"` + `role="row"` + `role="gridcell"` which explicitly permits nested interactive widgets. Pairs with MAINT-128: when each god-component is split (PageBrowser, TrashView, ConflictList, HistoryView, StaticBlock), re-evaluate the list role choice and remove the axe suppressions. PageBrowser specifically has the strongest case for grid given the FEAT-14 mixed-mode children. May be deferred behind MAINT-128 or shipped earlier as a per-file role flip — the role change is independent of the file-size split. | M |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S |
| PERF-23 | PERF | `read_attachment_file` buffers whole file before chunked send | S |
| PUB-2 | PUB | Git author email across all history is corporate (`javier.folcini@avature.net`) | S |
| PUB-3 | PUB | Employer IP clearance before public release | S |
| PUB-5 | PUB | Tauri updater — endpoint URL pinned to `jfolcini/agaric`; remaining work is user-only (generate Minisign keypair, paste pubkey into `tauri.conf.json`, add 2 GH Actions secrets, uncomment env vars in `release.yml`) | S |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S |
| UX-10 | UX | DuePanel projected (future-recurrence) entries indistinguishable from real tasks — only a dashed border and muted colour; no "Projected" pill per entry; long content is `truncate`d without a `title=` tooltip | S |
| UX-11 | UX | Focus management edge cases — BlockContextMenu `handleCloseWithFocus` has no fallback when the trigger element was removed (focus lands on `<body>`); context menu animates in from off-screen before `computePosition` resolves; `use-block-keyboard` suppresses arrow keys when a `.suggestion-popup` is found even if the node is `!isConnected`; PageBrowser double focus ring (outer div + inner button) | S |
| UX-12 | UX | Low-severity polish batch — PropertyRowEditor save disables whole ref-picker list instead of the saving row; PropertyRowEditor pencil button missing aria-label; LinkEditPopover error state omits `border-destructive` on the Input; BlockInlineControls due-date chip uses dynamic colour but scheduled-date chip is static; BlockContextMenu "No actions available" should close instead of render a dead menu; FeatureErrorBoundary shows raw `error.message` with no data-safety copy; BugReportDialog required checkbox has no required marker; PairingQrDisplay passphrase has no copy button + pause indicator is visually subtle; PeerListItem address-edit popover has no close/Cancel button + address error has no format hint + help text is `text-[10px]`; DataSettingsTab import progress is text-only; JournalCalendarDropdown legend dots are 8 px; AgendaResults group headers use `text-xs text-muted-foreground`; AgendaFilterBuilder pills lack `title=` on truncated values; `useDateInput` 300 ms NL-parse debounce has no visible "parsing…" hint; TemplatesView no-search-results message doesn't show total count; BugReportDialog log preview truncated at 500 chars with no "view full" option; ConflictListItem conflict-type badge has no `cursor-help` / visual tooltip affordance | M |

> **`PUB-*` statuses are heterogeneous now that the publish target is concrete (`github.com/jfolcini/agaric`).**
> PUB-5 / PUB-8 are ACTIONABLE; PUB-2 / PUB-3 remain DEFERRED on the identity / employer-IP decisions. macOS + Windows code signing are explicitly out of scope: the maintainer opted out of paid Apple Developer Program enrollment ($99/year) and Windows OV/EV certs ($200–400/year) for this OSS project. Bundles ship unsigned with Gatekeeper / SmartScreen first-launch warnings; see `BUILD.md` → "Desktop code signing in CI" for the user-facing install instructions.

---

## FEAT — Planned Feature Improvements

### FEAT-3 — Spaces: partition pages into user-defined contexts (work / personal)

> **Navigation-cluster context (FEAT-7/8/9 already shipped):** the shell-level TabBar hoist, active-tab dropdown switcher, and Recent-pages strip landed against the global `useNavigationStore.tabs` + `useRecentPagesStore.recentPages` models. Phase 3 of FEAT-3 is what refactors both of those into per-space state: `tabs` → `tabsBySpace: Record<SpaceId, Tab[]>`, `recentPages` → `recentPagesBySpace: Record<SpaceId, string[]>`. The already-shipped component DOM + styling stays; only the selector / data source shifts. One-line swaps in `TabBar.tsx` + `RecentPagesStrip.tsx` + `keyboard-config.ts`.

**Problem:** A user wants to partition notes into independent contexts (e.g. "work" and "personal") and switch between them quickly during the day without seeing cross-context data. The app currently presents a single undifferentiated vault: pages, tags, properties, agenda, graph, backlinks, tabs, and the journal all share one namespace.

**User decisions recorded up front (do not re-litigate during implementation):**

- **Per-space journal (J1).** Each space owns its own daily note. Today's journal page is keyed by `(date, current_space_id)`, not by `date` alone. Daily pages in different spaces coexist with the same title.
- **Per-space tabs.** Tabs are scoped to the active space. Switching space swaps the tab set. No tab shows pages from multiple spaces.
- **Nothing outside of spaces.** Every page must belong to exactly one space. No "All" pseudo-space, no unassigned pages, no cross-space "show everything" view. If the user needs to see another context, they switch space.
- **No links between spaces, ever.** Same page title in both spaces is fine and stays distinct (different ULIDs). Any `[[ULID]]` chip whose target lives in another space renders via the existing broken-link UX and is not clickable to navigate. See FEAT-3p7 for the enforcement scope. See "User decisions locked in" below for the full policy.

**Model:**
A **space** is a regular `page` block with a marker property `is_space = true`. Every non-space page has a `space` `ref` property pointing to its owning space. This reuses the properties system (AGENTS.md: "primary extension point"), adds no new tables, no new op types, no sync protocol changes.

**Schema (additive only — new migration):**

```sql
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) VALUES
    ('space',    'ref',  NULL, '<ts>'),
    ('is_space', 'text', NULL, '<ts>');

CREATE INDEX IF NOT EXISTS idx_block_properties_space
    ON block_properties(value_ref)
    WHERE key = 'space';
```

**Frontend (summary):**

- `src/stores/space.ts` — new Zustand store: `currentSpaceId`, `availableSpaces`, `setCurrentSpace`, `refreshAvailableSpaces`. Persisted under `agaric:space`.
- `src/components/SpaceSwitcher.tsx` — sidebar-top Radix `Select` (reuse `ui/select.tsx`) with "Manage spaces…" action. **Replaces** the current static branding block at `src/App.tsx:798-805`. Visible on both desktop and mobile (spaces are a higher-level scope than tabs — mobile users still need context switching). New keyboard entries in `keyboard-config.ts`: `switchSpace` (default Ctrl+Shift+S, opens a `SearchablePopover` to jump by name) and `cycleSpace` (default Ctrl+Alt+S, rotates).
- `useNavigationStore` refactor: `tabs: Tab[]` → `tabsBySpace: Record<SpaceId, Tab[]>`, `activeTabIndex: number` → `activeTabIndexBySpace: Record<SpaceId, number>`. Every action (`navigateToPage`, `goBack`, `openInNewTab`, `closeTab`, `switchTab`) reads/writes the current space's slice. `selectPageStack` becomes space-aware. Persistence `partialize` serializes the full map; on rehydrate, if the persisted `currentSpaceId` no longer resolves, fall back to the first existing space.
- `PageHeaderMenu` gains a "Move to space" action.
- `JournalPage` — daily-page lookup by `(date, current space)`.
- Status bar chip shows the active space name (follows the existing sync-status chip pattern).

**Backend (summary):**

A `space_id: String` param (required, not optional, to enforce "nothing outside of spaces") is threaded through the query commands that surface multiple pages:
`list_blocks`, `search_blocks`, `query_by_tags`, `query_by_property`, `get_backlinks`, `query_backlinks_filtered`, `list_backlinks_grouped`, `count_agenda_batch`, `count_agenda_batch_by_source`, `list_undated_tasks`, `list_page_links`, `list_projected_agenda`.

Shared SQL helper resolves content blocks to their page ancestor via the existing `page_id` column (migration 0027) and filters by the `space` ref property:

```
AND COALESCE(b.page_id, b.id) IN (
    SELECT bp.block_id
    FROM block_properties bp
    WHERE bp.key = 'space' AND bp.value_ref = ?
)
```

**Atomic "create page in current space":** reuse the `_in_tx` transaction pattern (AGENTS.md: "Backend Patterns #2"). A new helper begins `BEGIN IMMEDIATE`, calls `create_block_in_tx` for the page, then `set_property_in_tx` for `space`, then commits. All-or-nothing. A page must never exist without a `space` property.

**Journal (J1):**
`commands/journal.rs` daily-page lookup changes from "find page where `title = YYYY-MM-DD`" to "find page where `title = YYYY-MM-DD` AND `space = current`". Creating today's journal page sets its `space` property atomically in the same transaction. Per-space journal templates can be expressed as a `journal_template` property on each space page (no new schema).

**Per-space tabs implementation:**

- `tabsBySpace[currentSpaceId]` read on every render. The tab bar hides normally when the current space has ≤1 tab (FEAT-7 autohide guard preserved).
- Opening a page in a new tab only affects the current space's tab list.
- Space deletion requires closing/reassigning all tabs in that space (see Open Questions).

**Per-space recent-pages (FEAT-9 coupling):**

- `recentPages: string[]` → `recentPagesBySpace: Record<SpaceId, string[]>`. Same dedup + MRU rules apply per-space. Switching space swaps the strip.
- Visits never cross space boundaries (matches "nothing outside of spaces").
- Implementation goes in the same session as the tab refactor so both structures move together.

**Sync implications:**
Space pages and `space` properties replicate as normal ops. Every device sees every space. Matches the AGENTS.md threat model (single-user, multi-device, no adversarial peers). Per-space sync meshes would be a separate, significant architectural change (multi-DB or sync-scope filtering) and require their own design approval.

**Default-space bootstrapping (resolved — Phase 1 shipped):**
Fresh installs and upgrades both run a boot-time Rust bootstrap (`src-tauri/src/spaces/bootstrap.rs`) that creates two seeded spaces with reserved deterministic ULIDs — `SPACE_PERSONAL_ULID = "00000000000000000AGAR1CPER"` and `SPACE_WORK_ULID = "00000000000000000AGAR1CWRK"`. Each device emits its own CreateBlock + SetProperty(`is_space`=true) ops for both; op_log hashes differ per-device (device_id is part of the hash preimage, which is unavoidable under the current per-device hash-chain model) but the materializer's `INSERT OR IGNORE` on `blocks` converges every device on the same two rows. User-created spaces after that use normal per-device ULIDs — two "Project X" spaces on different devices stay distinct until manually reconciled. Upgrade path: every existing non-space page without a `space` property gets a local `set_property(page, 'space', PERSONAL_ULID)` op; non-deterministic timestamps are fine — `block_properties` UPSERTs on `(block_id, key)` converge. Bootstrap is idempotent (fast-path skip when both seeded blocks exist with `is_space = 'true'`) and partial-crash resumable (per-step commits).

**Testing (per AGENTS.md):**

- Every backend command gaining `space_id`: happy path, cross-space exclusion, nonexistent `space_id` returns empty, exact-count assertions (`assert_eq!` over `assert!(>= 1)`).
- Property test (`fast-check`): for any two non-empty spaces, their page sets are disjoint and their union equals the full non-space page set.
- `SpaceStore` + `SpaceSwitcher`: render + interaction + `axe(container)`.
- `useNavigationStore` rehydrate after space deletion, persistence round-trip for `tabsBySpace`.
- Journal per-space lookup, including the transition from "no journal today" to "journal created in current space".
- Recursive CTE walkers (`list_children`, cascade ops) unchanged — `is_conflict = 0` + `depth < 100` invariants preserved. Space is a query-time filter, not a structural partition.

**Rollout phases (each independently shippable, gated by mandatory review subagent per AGENTS.md):**

1. **Migration + model + wizard — SHIPPED.** Property definitions (migration 0035), boot-time Rust bootstrap emitting seeded spaces + upgrade ops, `src-tauri/src/spaces/` module, `list_spaces` command, `SpaceStore` (Zustand + persist), `SpaceSwitcher` (Radix Select in `SidebarHeader`).
2. **List/search filtering — SHIPPED.** `list_blocks` + `search_blocks` accept `space_id: Option<String>` (threaded through `pagination::list_children` / `list_by_type` / `list_trash` + `fts::search_fts` via the `?N IS NULL OR COALESCE(b.page_id, b.id) IN (...)` filter pattern). PageBrowser + SearchPanel pass `currentSpaceId` and gate render on `useSpaceStore.isReady` via `LoadingSkeleton`. Link picker (`useBlockResolve`'s `searchPagesViaCache` / `searchPagesViaFts`) scoped to current space — current-space-only per user decision, no opt-in toggle. "Move to space" action in the PageHeader kebab menu uses the existing `setProperty` wrapper (no new Tauri command). New atomic command `create_page_in_space` wraps `CreateBlock` + `SetProperty('space')` in a single `BEGIN IMMEDIATE`; all top-level page-creation callsites (sidebar "New page", Ctrl+N, PageBrowser inline form, link picker "Create new page") route through it. `AgendaQuery` struct bundles the three agenda knobs to keep `list_blocks` under the tauri-specta 10-arg limit. `useResolveStore.clearPagesList()` fires on space switch so the link picker's short-query cache doesn't surface other-space pages.
3. **Per-space tabs + per-space recent — SHIPPED.** Refactored `useNavigationStore` to `tabsBySpace` + `activeTabIndexBySpace` AND `useRecentPagesStore` to `recentPagesBySpace`. Subscriber on `useSpaceStore.currentSpaceId` flushes the outgoing space's flat fields into its slice, then pulls the incoming space's slice into the flat fields (`navigation.ts:489-548`, `recent-pages.ts:130-167`). `TabBar.tsx` and `RecentPagesStrip.tsx` consume the per-space selectors `selectTabsForSpace` / `selectRecentPagesForSpace`. Tests cover space-deletion corner case + rehydrate with stale `currentSpaceId` + cross-space MRU isolation.
4. **Agenda / graph / backlinks / tags / properties — FEAT-3p4.** Remaining query commands gain the filter: `list_undated_tasks`, `list_projected_agenda`, `query_by_tags`, `query_by_property`, `list_page_links`, `get_backlinks`, `list_backlinks_grouped`, `query_backlinks_filtered`, `count_agenda_batch*`. Plus: promote `space_id` from `Option` to required on `list_blocks` / `search_blocks`; page-membership check in `get_page_inner`; per-space `useNavigationStore.currentView` slice. See FEAT-3p4 entry for full scope.
5. **Per-space journal (J1) — FEAT-3p5.** Daily-page lookup by `(date, space)`. Per-space journal templates via a `journal_template` property on each space block. JournalPage's 4 internal `createBlock({blockType: 'page'})` callsites route through `createPageInSpace`. Per-space `useJournalStore.currentDate` slice. See FEAT-3p5 entry for full scope.
6. **Manage-spaces UI — FEAT-3p6.** Rename, delete-only-if-empty (no soft-delete, no reassign-on-delete), accent-color picker (consumed by FEAT-3p10), onboarding for second space. *(Status-bar chip / collapsed-icon indicator / brand identity moved to FEAT-3p10; keyboard shortcuts split into FEAT-3p11.)*
7. **Cross-space link enforcement — FEAT-3p7.** Resolve store + `get_page_inner` filter by current space. Cross-space `[[ULID]]` chips render via the existing broken-link UX. Defence-in-depth against legacy text + manual paste + post-"Move to space" stale references. **Implements the locked-in "no links between spaces, ever" decision.**
8. **History view space scoping — FEAT-3p8.** History defaults to current space; "All spaces" toggle in `HistoryFilterBar` (off by default, not persisted).
9. **Per-space external integrations — FEAT-3p9.** Per-space GCal calendar IDs / OAuth tokens / push pipeline. OS notification titles prefix `[<SpaceName>]` (FEAT-11 coupling).
10. **Visual identity — FEAT-3p10.** Per-space accent color (CSS custom property override) + status-bar chip + window title prefix + collapsed-sidebar indicator. **Single highest-priority remaining FEAT-3 phase for the "fully separated feel" goal.**
11. **Digit hotkeys — FEAT-3p11.** `Ctrl+1` … `Ctrl+9` (`Cmd+1` … `Cmd+9` on macOS) switch directly to the Nth space in alphabetical order. Additive to FEAT-3p6's popup-search and cycle bindings — fastest possible motion (one chord) for the common 2-space case.

**User decisions locked in (do NOT re-litigate):**

- **Seeded spaces count:** 2 — "Personal" + "Work".
- **Bootstrap:** deterministic genesis ops (two reserved ULIDs above) + local upgrade ops for existing pages.
- **Space deletion:** forbid deleting a non-empty space (no soft-delete, no reassign-on-delete).
- **Spaces are physically separate vaults from the user's perspective. NO live links between spaces, ever.** Picker is current-space-only (Phase 2 shipped). Resolve store and single-page fetch are current-space-only (FEAT-3p7). Any `[[ULID]]` whose target lives in another space — regardless of how it got there (legacy text written before Phase 2, post-"Move to space" stale references in the source space, manually-pasted ULIDs, sync replay of older content) — renders as a **broken-link chip via the existing broken-link UX** (`block-link-deleted` styling, "Broken link — click to remove" tooltip, click deletes the chip). **No auto-switch on click. No "show anyway" toggle. No developer override.** A single behaviour, period.
- **Same page title in both spaces is allowed and stays distinct.** "Daily standup" in Personal and "Daily standup" in Work are two separate pages with two ULIDs. Titles are not a cross-space resolution surface. Title-based search is space-scoped (Phase 2 shipped); title collisions across spaces are invisible from inside any one space.
- **Graph view:** no cross-space edges to render (follows from "no links between spaces").
- **Export:** markdown export references only stay within the current space (follows from "no links between spaces"; cross-space `[[ULID]]` targets export as the same broken-chip placeholder that the UI renders).
- **First-boot UI:** LoadingSkeleton on space-scoped panels until `useSpaceStore.isReady === true`.
- **Search operator:** the switcher is the only scoping surface — no `space:<name>` operator.

**Cost:** S — this umbrella entry is now a tracker only. Each remaining phase is filed as its own item: FEAT-3p4 (agenda/graph/backlinks), FEAT-3p5 (journal), FEAT-3p6 (manage UI), FEAT-3p7 (broken-chip enforcement), FEAT-3p8 (history scoping), FEAT-3p9 (per-space integrations), FEAT-3p10 (visual identity), FEAT-3p11 (digit hotkeys). Schedule via the per-phase items, not this umbrella.

**Recommended sequencing for "fully separated feel + easy/quick switching":** FEAT-3p10 + FEAT-3p11 + FEAT-3p7 first (one session each, low blast-radius, immediately unlock the user-visible goal). Then FEAT-3p4 (largest backend slice, closes the remaining query leaks). Then FEAT-3p5 / p6 / p8 / p9 in any order.

**Status:** IN PROGRESS — Phases 1 + 2 + 3 shipped. Remaining work tracked under FEAT-3p4 / FEAT-3p5 / FEAT-3p6 / FEAT-3p7 / FEAT-3p8 / FEAT-3p9 / FEAT-3p10 / FEAT-3p11.

### FEAT-3p4 — Spaces Phase 4: agenda / graph / backlinks / tags / properties scoping

**Problem:** The remaining query commands still surface cross-space results. `list_undated_tasks`, `list_projected_agenda`, `query_by_tags`, `query_by_property`, `list_page_links`, `get_backlinks`, `list_backlinks_grouped`, `query_backlinks_filtered`, `count_agenda_batch`, `count_agenda_batch_by_source` all need `space_id: Option<String>` threaded through, with the `?N IS NULL OR COALESCE(b.page_id, b.id) IN (...)` filter pattern established in FEAT-3 Phase 2.

**Backend scope:**
- Thread `space_id` through every command in the list above. Reuse the `space_filter_clause!` macro and the FEAT-3 helper that resolves content blocks to their page ancestor via the `page_id` column + `space` ref property.
- `AgendaQuery` struct already bundles the three agenda knobs to keep `list_blocks` under the tauri-specta 10-arg limit; reuse the same struct shape for the new agenda commands if any cross the limit.
- For each command: happy path, cross-space exclusion, nonexistent `space_id` returns empty, exact-count assertions (`assert_eq!`, never `>=`).
- Property test (`fast-check`): for any two non-empty spaces, their result sets are disjoint and their union equals the full non-space result set.

**Frontend scope:**
- Migrate every callsite of the listed commands to pass `currentSpaceId`: `useBlockTags`, `agenda-filters`, `GraphView.helpers`, `export-graph`, backlinks views, `TrashView`, `useResolveStore.preload()`, template helpers, property UI.
- Status-bar chip showing the active space name (follows existing sync-status chip pattern).
- Optional polish (P2 from UX review): a subtle "Pages in &lt;SpaceName&gt;" header on the link-picker suggestions so the current-space scoping isn't silent.

**Recursive CTE invariants preserved:** `list_children`, cascade ops unchanged. Space is a query-time filter, not a structural partition. `is_conflict = 0` + `depth < 100` invariants stay where they are.

**Additional scope (folded in from confirmed leakage findings):**

- **Promote `space_id` from `Option<String>` to `String` (required) on `list_blocks_inner` + `search_blocks_inner`.** Phase 2 shipped these as `Option<String>` for backwards-compat during incremental rollout; the locked-in user decision was "required, not optional, to enforce 'nothing outside of spaces'". New callers can currently leak silently by omitting `spaceId`. Required signature blocks that at the type system + tauri-specta layer. Migrate every existing callsite in the same commit (no flag-day window with mixed signatures).
- **`get_page_inner` page-membership check.** When called with a `space_id`, verify the requested page's `space` property matches; otherwise return `AppError::Validation("page not in current space")`. Defence in depth — without this, deep-link / legacy `[[ULID]]` paths can fetch foreign-space pages directly. Same check applied to `get_block_with_children_inner`. (Couples loosely with FEAT-3p7, which is the user-facing "no cross-space links" enforcement; this item is the backend-rejection corollary.)
- **Per-space `useNavigationStore.currentView` slice.** Today `currentView: View` is global, so `Search` view in Personal stays `Search` when the user switches to Work. Add `currentViewBySpace: Record<SpaceId, View>` mirroring the `tabsBySpace` pattern; the Phase 3 space-switch subscriber gains one extra flush/pull pair. Vitest covers: switch from Personal-search → Work resets to Work's last view (or default `page-editor` for fresh spaces).

**Cost:** L — biggest remaining FEAT-3 slice (10+ commands × backend + 7+ frontend areas + property tests + the three additional items above). Realistic estimate: 2 focused sessions.
**Status:** Open. Depends on FEAT-3 Phases 1 + 2 + 3 (shipped). Independent of FEAT-3p5, FEAT-3p6, FEAT-3p7, FEAT-3p8, FEAT-3p9, FEAT-3p10, FEAT-3p11.

### FEAT-3p9 — Spaces Phase 9: per-space external integrations (GCal, OS notifications)

**Problem:** Two integration surfaces leak across spaces today:

1. **Google Calendar push** uses a single `calendar_id` in `GcalStatus` (`src-tauri/src/commands/gcal.rs:56-66`). The push pipeline (`gcal_push/connector.rs`) pulls agenda items via `list_projected_agenda_inner` — which is also unscoped today (FEAT-3p4 covers the read path) — and writes every item from every space into one calendar. A user with the integration on cannot keep their work calendar separate from their personal one.
2. **OS notifications** (FEAT-11, deferred): when adopted, due-task notifications will show task content with no space attribution. A Work task firing while the user is "in" Personal breaks context.

**Locked-in policy:**

- **GCal config is per-space.** A user can connect GCal independently for each space, with independent calendar IDs, OAuth tokens (via the existing keychain wrapper, key suffixed with the space ULID), window-days, privacy-mode, push-lease. A space with no GCal connection has no GCal sync — period. **No global fallback.**
- **Push pipeline branches by space.** Each space's push loop pulls agenda items scoped to that space (via FEAT-3p4's space-aware `list_projected_agenda`) and writes to that space's calendar. A failed push for one space does not block others.
- **OS notifications carry the space name.** Title format becomes `[<SpaceName>] <existing title text>` so the user always knows which context fired the notification, regardless of the active space at the moment.

**Backend scope (GCal):**

- New schema: `gcal_space_config` table — `(space_id PRIMARY KEY, account_email, calendar_id, window_days, privacy_mode, last_push_at, last_error)` — additive migration. OAuth tokens stay in the keychain but the keychain key is suffixed with the space ULID (`agaric-gcal-token-<space_ulid>`).
- Replace `GcalStatus` (single struct) with `Vec<GcalSpaceStatus>`: `(space_id, account_email, calendar_id, window_days, privacy_mode, push_lease, last_push_at, last_error, connected)`. Top-level `get_gcal_status` returns the vec keyed by space.
- `gcal_push::connector::push_loop` iterates the configured spaces and runs an isolated push per space. Per-space `push_lease` lives in `gcal_space_config.push_lease` (or a dedicated `gcal_space_lease` table if leases must outlive config rows).
- Per-space versions of every existing command: `force_gcal_resync(space_id)`, `disconnect_gcal(space_id)`, `connect_gcal(space_id)`, `set_gcal_window_days(space_id, days)`, `set_gcal_privacy_mode(space_id, mode)`. Settings tab UI gains a per-space accordion.

**Backend scope (notifications, when FEAT-11 lands):**

- Notification builder reads the firing task's owning page's `space` property and prefixes the title with `[<SpaceName>] `. No new schema. Lookup is one `block_properties` read per notification, fine at notification frequency. Couples with FEAT-11 — this sub-task ships alongside or after FEAT-11.

**Migration:**

- Existing single-space GCal config (if connected) migrates to the user's currently-active space at first run after this phase ships. Tracked as a one-shot Rust bootstrap step, idempotent, behind a `gcal_per_space_migrated` flag (mirrors the spaces bootstrap pattern).

**Testing:**

- Two configured spaces push to two different `calendar_id`s; per-space `last_push_at` advances independently.
- Disconnect on space A leaves space B's push working.
- Failed push on space A does not block the per-loop tick for space B.
- Notification title always carries the originating space, regardless of active space.

**Cost:** L — schema migration + connector refactor + UI refactor + per-space lease handling. Realistic estimate: 2 sessions. Depends on FEAT-3p4 (the push pipeline must already pull space-scoped agenda).
**Status:** Open. Depends on FEAT-3p4. Independent of FEAT-3p5 / p6 / p7 / p8 / p10 / p11. Notification-prefix sub-task depends on FEAT-11 landing first.

### FEAT-4 — Agent access: expose notes to external agents via an MCP server

**Problem:** External agents (Claude Desktop, Claude Code, Cursor, Devin, Continue, etc.) cannot read from or write to the user's notes. The user wants to let agents interact with their vault in a controlled way — starting with desktop, potentially extending to mobile later — without handing over the database file or bypassing the op-log / CQRS invariants.

Out of scope for this item: cloud-hosted inference, remote agents, multi-user authorization, any non-local transport (see "Mobile" below for the deferred story).

**User decisions recorded up front (do not re-litigate during implementation):**

- **Two sockets, not one.** Read-only access and read-write access live on **separate** Unix-domain sockets (named pipes on Windows) with independent toggles. No runtime scope negotiation, no per-tool allowlist in v1. User points their agent at whichever socket they want to grant.
- **Read-only first.** v1 ships the RO socket + 9 read tools only. Write tools are deferred to v2 so the user can live with read-only agents before granting mutation. The architecture must leave the RW slot obviously open so v2 is purely additive.
- **Writes (when they land in v2) apply straight to the op log**, tagged with `origin = "agent:<name>"` where `<name>` is the MCP `clientInfo.name` from the handshake. No staging queue, no user-confirmation modal per write. Safety comes from the existing op-log undo (`reverse.rs`) plus a new "recent agent activity" feed and one-click bulk revert.
- **Non-reversible ops are never exposed to agents**, even with RW. `purge_block` and `delete_attachment` (the two `NonReversible` variants in `AppError`) stay frontend-only. Agents can `delete_block` (reversible soft-delete) but cannot purge.

**Protocol:** Model Context Protocol (JSON-RPC 2.0 over a local transport). Every mainstream agent already speaks MCP, so there is no custom client to ship.

**Transport (desktop):**

- Linux/macOS: Unix-domain socket at `~/.local/share/com.agaric.app/mcp-ro.sock` (and, in v2, `mcp-rw.sock`), mode `0600`.
- Windows: named pipe `\\.\pipe\agaric-mcp-ro` (and `...-rw` in v2) with an ACL that grants only the current user.
- Rationale matches AGENTS.md threat model: single-user, no adversarial actor, no cloud. The kernel enforces "only this user's processes can connect" with zero crypto, zero tokens, zero MITM surface. Do not add bearer tokens, rate limits, or path-traversal hardening against the agent — the threat model does not justify the complexity.

Because MCP clients launch their server as a stdio subprocess, a small stub binary `src-tauri/src/bin/agaric-mcp.rs` bridges stdio ↔ UDS/pipe. That stub is what the user pastes into their agent's config (`command: "agaric-mcp"`, optional `args: ["--socket", "<path>"]`, env discovery via `$AGARIC_MCP_SOCKET` with the sensible default above). The stub must be packaged alongside the Tauri app binary on every platform.

**Architecture:**

- New module `src-tauri/src/mcp/` — a Tokio task started alongside `sync_daemon` in the same lifetime. Binds the enabled socket(s), accepts connections, dispatches JSON-RPC requests into a tool registry.
- **Registry trait** + two impls planned: `ReadOnlyTools` (wired in v1) and `ReadWriteTools` (wired in v2). The socket plumbing takes the registry as a generic parameter so the same server code serves both sockets.
- Every tool handler is a thin wrapper around an existing `*_inner` command handler (there are ~78 in `src-tauri/src/commands/`, each taking `&SqlitePool`). **Never bypass the command layer.** Doing so would violate invariants 1, 2, 5, and 9 from AGENTS.md (append-only op log, CQRS split, sqlx compile-time queries, CTE correctness).
- **`ActorContext` threaded through from day one.** Even in v1, MCP handlers pass `Actor::Agent { name }` (vs the implicit `Actor::User` used by frontend-invoked commands). In v1 it is only used for structured logging; in v2 it populates the op-log origin column without a schema-change surprise. The `ActorContext` plumbing is the only non-local change v1 makes to existing command handlers — keep it a purely additive parameter (or a `tokio::task_local!`) so frontend call sites remain untouched.
- **Pool usage:** MCP tools use the reader pool only in v1. v2 write tools acquire the writer pool exactly like regular commands (no new pool).
- **Subscriptions / live updates:** not in v1. If v2 or v3 wants them, they can ride on existing Tauri events re-emitted over MCP notifications — no new backend plumbing.

**Tool surface v1 — read only (9):**

| Tool | Backing `*_inner` | Notes |
|------|---------------------|-------|
| `list_pages` | (new: `list_pages_inner`) | Tiny new handler in `pages.rs` — query blocks where the page flag is set. No existing caller does this today; frontend uses backlinks / FTS. |
| `get_page` | (new: `get_page_inner`) | Composes `get_block_inner` (root) + `list_blocks_inner` (descendants). Thin wrapper, no new SQL. |
| `search` | `search_blocks_inner` (`queries.rs`) | FTS. Enforce snippet + result caps at the tool boundary (see Open Questions). |
| `get_block` | `get_block_inner` (`blocks/queries.rs`) | |
| `list_backlinks` | `list_backlinks_grouped_inner` (`queries.rs`) | |
| `list_tags` | (new: `list_tags_inner`) | Small wrapper over `list_tags_by_prefix_inner("")`. Keep the public MCP name simple. |
| `list_property_defs` | `list_property_defs_inner` (`properties.rs`) | Exposes the typed property schema so agents can sensibly use v2 write tools (`set_property`). Read-only, cheap, and prevents v1 agents from hardcoding property-key assumptions. |
| `get_agenda` | `list_projected_agenda_inner` (`agenda.rs`) | |
| `journal_for_date` | (new: `journal_for_date_inner`) | `today_journal_inner` / `navigate_journal_inner` exist but neither resolves an arbitrary date. Extract the shared lookup into a new thin helper both can delegate to — do **not** fork the logic. |

The four "(new)" handlers are in-module thin wrappers, not new surface area: they compose existing helpers. Each still follows the `pub async fn name_inner(pool: &SqlitePool, …) -> Result<…, AppError>` signature so they are uniformly testable and callable from MCP. `list_property_defs_inner` already exists at `properties.rs:447` — it wires through as-is, no new Rust function needed.

Each tool's JSON schema is pinned with an `insta` snapshot so accidental shape changes break CI.

**Tool surface v2 — deferred (6 write tools):**

`append_block`, `update_block_content`, `set_property`, `add_tag`, `create_page`, `delete_block` (reversible). Out of scope for v1; listed here so the registry layout is not a surprise.

**Frontend:**

- One new Settings tab **"Agent access"** composed from existing `ui/` primitives (Label, Switch, Button, ScrollArea, Badge per AGENTS.md frontend guidelines — no bespoke UI).
- RO enable/disable toggle (v1). RW toggle hidden / disabled pending v2.
- "Copy Claude Desktop config" + "Copy generic MCP config" buttons. Copies a JSON snippet with the correct command + socket path for the current OS.
- Socket path display + platform-appropriate "Reveal in file manager" button.
- Recent-activity feed: rolling 100-entry ring buffer emitted as Tauri events from `src-tauri/src/mcp/`, rendered with `ScrollArea` + existing list primitives. In v1 entries are read-only queries with tool name + summary + timestamp. In v2, write entries gain a one-click "Undo" action wired to `reverse.rs`.
- Kill switch (disconnects all active sessions immediately).
- i18n keys for every user-visible string. `aria-label` on every icon-only button. `axe(container)` test.

**Backend file layout:**

```
src-tauri/src/mcp/
    mod.rs              — task lifecycle, socket binding, config
    server.rs           — JSON-RPC dispatch, per-connection state
    registry.rs         — ToolRegistry trait
    tools_ro.rs         — ReadOnlyTools impl (v1)
    tools_rw.rs         — ReadWriteTools impl (v2, empty stub in v1)
    activity.rs         — ring buffer + Tauri event emitter
    actor.rs            — ActorContext + task-local plumbing
    tests/              — handshake, each tool, permission, concurrency
src-tauri/src/bin/
    agaric-mcp.rs       — stdio ↔ socket stub
```

**Testing (per AGENTS.md conventions):**

- **Rust:** handshake + each tool (happy + error), socket permission check (mode 0600 on unix, owner-only ACL on windows), concurrent-client stress (≥8 parallel clients sharing the reader pool), `insta` snapshots of every tool's JSON schema, property test over `search` with random queries asserting FTS parity vs direct `search_blocks_inner` call, exact-count assertions (`assert_eq!`, never `>=`).
- **Frontend:** Settings tab render + interaction + `axe(container)`, activity feed component with mocked event stream, copy-config button copies the right snippet per platform.
- **Smoke:** small Python harness using the official `mcp` package exercises the full tool surface end-to-end against a dev build of the Tauri app. Runs manually, not in CI (dev-build dependency).
- **Packaging:** verify `agaric-mcp` binary is included in Linux `.deb`, macOS `.app`, and Windows `.exe` installer outputs (add to `tauri.conf.json` `bundle.resources` or equivalent).

**Documentation:**

- `README.md` — short user-facing "Using an agent with Agaric" section with Claude Desktop / Cursor config snippets.
- `FEATURE-MAP.md` — new entry under the appropriate domain.
- **No changes to `AGENTS.md`** (per the AGENTS.md invariant at the top of that file).

**Rollout phases (each independently shippable, gated by mandatory review subagent per AGENTS.md):**

1. **v1 — RO server.** `src-tauri/src/mcp/` task, `agaric-mcp` stub binary, 9 read tools, Settings tab with toggle + copy-config + activity feed (reads only). Packaging updates so the stub ships with the installer. Full test suite + smoke harness. Sub-items: FEAT-4a..FEAT-4g.
2. **v2 — RW server.** `mcp-rw.sock`, 6 write tools, `ActorContext` → op-log origin wiring (additive migration for the column — the current `op_log` schema has no `origin` column, so v2 adds one via a new migration), activity feed gains write entries + one-click undo. Bulk "revert all agent ops from session X" action. Sub-item: FEAT-4h.
3. **v3 — Mobile (deferred, design sketch only).** Reuse `sync_cert.rs` + `sync_daemon` mTLS plumbing to expose MCP over HTTPS on the LAN, with an agent-pairing flow that mirrors device pairing. Not started; requires its own design approval before Phase 3. Sub-item: FEAT-4i.

**Open questions (must be resolved before v1 implementation starts):**

- **Auto-start vs opt-in.** Does the MCP server start automatically on app launch (current sidebar toggle gates only accepting connections) or does it only start when the user flips the toggle? Recommend opt-in (off by default, user flips once, persisted).
- **Socket path on Android / iOS.** `app_data_dir()` on Android is `/data/data/com.agaric.app/` — UDS works there but other processes cannot reach it unless they share a sandbox. Confirm this is deferred entirely to Phase 3 (it is, per the user's "desktop first" direction) and not quietly shipped half-broken in v1.
- **Search result size cap.** FTS snippets can be large. Does `search` enforce a hard per-result snippet-length cap + a hard result-count cap? Recommend 512 chars / 50 results by default, overridable via tool params.
- **Config-copy UX.** Should "Copy Claude Desktop config" also offer a "Write directly into `claude_desktop_config.json`" one-shot button, or stay docs-only? Recommend docs-only in v1 — writing into third-party config files is a support trap.
- **Multi-app coexistence.** If the user launches a second Agaric instance (dev build alongside release), they race on the same socket path. Recommend the second launcher detects the existing socket, logs a warning, and does not bind — no cross-instance fallover.
- **Tool-call observability.** Do we persist MCP activity beyond the in-memory ring buffer, and if so for how long? Recommend in-memory only for v1 (no new table, no new retention policy decision).
- **Client identification beyond `clientInfo.name`.** MCP `clientInfo` is self-reported and spoofable. For single-user-local-only this is fine, but confirm we are not building any authorization logic on top of it (we are not, and should not).

**Cost:** L — spans one new backend module (~6 files), one new bin target, one new Settings tab, packaging updates on 3 platforms, ~30 tests across frontend and backend, and a smoke harness. Realistic estimate: 2–3 focused sessions for v1; v2 a separate 2-session batch.

**Decision:** Accept the recommended answers to all 6 open questions — opt-in auto-start (off by default), Android deferred to Phase 3, search capped at 512 chars / 50 results by default, docs-only config copy, second-instance detects existing socket and does not bind, in-memory ring buffer only, no authorization on `clientInfo.name`. v1 ready to schedule in a future dedicated session.

**Implementation DAG (v1):**

```
4a ──┐
     ├──▶ 4c ──┬──▶ 4d ──┐
     │        │         ├──▶ 4e ──▶ 4g
4b ──┘        └──▶ 4f ──┘
```

First wave (parallel): `4a` + `4b` — independent implementations (socket transport and the tool-registry trait are separate files that don't import each other). They meet at `4c`'s integration point. Second wave: `4c`. Third wave (parallel): `4d` + `4f`. Fourth wave: `4e`. Fifth wave: `4g`.

**Status:** IN PROGRESS — v1 (FEAT-4a..FEAT-4g, RO server + 9 read tools + Settings tab + activity feed) shipped. v2 complete: slices 1-2 (op-log `origin` column + RW socket + 6 write tools + Settings toggle), slice 3 (activity-feed per-entry Undo + FEAT-4c emission wiring), and slice 4 (per-session bulk revert) all shipped. v3 (FEAT-4i, Mobile) DEFERRED pending user-requested mobile support + separate design approval.

### FEAT-4i — MCP v3: Mobile (HTTPS/LAN via mTLS reuse from `sync_cert.rs`, agent-pairing flow)

Part of the FEAT-4 family. See FEAT-4 for the v3 rollout phase specification (design sketch only).

**Scope (when designed + approved):**

- Reuse `src-tauri/src/sync_cert.rs` (the existing persistent TLS certificate infrastructure used by `sync_daemon` for device-to-device mTLS) to expose MCP over HTTPS on the LAN.
- Agent-pairing flow mirrors the device-pairing UX already shipped in the Sync feature — user scans a QR code or enters a short code on the agent-running machine; the Agaric device trusts the agent's cert after explicit acceptance.
- Same protocol (JSON-RPC 2.0, same tool registry) — only the transport changes.
- Android-specific sandbox considerations (the UDS path on Android is inside the app's private data dir and other processes cannot reach it) handled by the new HTTPS-over-LAN transport.

**Do NOT** start this sub-item until both v1 and v2 have shipped and the user has explicitly asked for mobile support. Do NOT weaken the mTLS posture — the fact that the LAN is "the user's own network" does not change the requirement to authenticate both ends with device-owned certs.

**Verification (when scheduled):** reuse the existing `sync_daemon/` test harness patterns; add a pairing flow e2e test; verify the stub binary runs on both Android (via Tauri's Android target) and iOS (out of scope for the first mobile release — iOS comes later if at all).

**Depends on:** FEAT-4h (v2 complete) + separate design-approval session before implementation begins.

**Status:** DEFERRED — pending v2 ship + user-requested mobile support + separate design approval.

**Cost:** L

### FEAT-5 — Google Calendar daily-agenda digest push (Agaric → dedicated GCal calendar)

**Problem:** Users want their Agaric agenda to appear on their Google Calendar — **constantly updated**, not with the hours-to-~24h lag of `.ics` subscription feeds. This item covers the architecture, user decisions, threat-model deviation, and rollout for pushing a **daily agenda digest** (one all-day event per date, containing that date's agenda entries) to a **dedicated Google Calendar owned by Agaric**. Bidirectional sync, per-task events, and `.ics` publication are explicitly out of scope (see rejected alternatives below). Individual implementation slices are filed as FEAT-5a..FEAT-5g.

**Rejected alternatives (do not re-litigate):**

- **One GCal event per task** (the original FEAT-5 shape). Rejected in favor of the daily-digest model: it multiplies sync surface, complicates repeat-rule handling (`.+` / `++` → up to 60 flat events per block), and pollutes the user's calendar with micro-entries. The daily digest shows "what's on my plate today" at a glance — the same mental model as the Agaric agenda itself.
- **Bidirectional sync.** Doubles complexity, requires inbound ops translation, forces conflict resolution across two data models (op-log hash chain vs GCal last-write-wins). One-way push covers the stated need ("see my agenda on my calendar") at a fraction of the cost.
- **`.ics` subscription feed (pull).** Google Calendar controls subscription refresh cadence (hours to ~24h, no webhook, no forceable poll). Pull also requires a publicly reachable URL. Fails the "constantly updated" requirement.
- **Google Tasks API.** Users want the agenda on their *calendar*, not in the Tasks pane.
- **CalDAV self-hosted.** Google Calendar does not consume CalDAV as a client.
- **Writing into the user's primary calendar.** Rejected: pollutes an existing calendar the user may share with others. Agaric creates and owns its own dedicated calendar, so the user can hide / share / color-code it independently, and disconnect cleanup is a single `calendars.delete` API call.

**User decisions (recorded up front, do not re-litigate):**

- **Push-only, one direction.** Agaric is always authoritative. GCal is a dumb mirror. Edits made inside GCal are silently overwritten on the next push — stated in the Settings UI so users are not surprised.
- **Daily digest, not per-task events.** One all-day event per calendar date. Event description lists that date's agenda entries as plain text.
- **Dedicated Agaric-owned calendar**, created on first connect (via `calendars.insert`), named "Agaric Agenda". The user never picks an existing calendar — Agaric owns the whole surface. The calendar ID is persisted in `gcal_settings.calendar_id`.
- **Threat-model deviation accepted for this feature only.** Off by default, opt-in per device, gated by a Settings toggle, isolated to the `src-tauri/src/gcal_push/` module. `AGENTS.md` §"Threat Model" is **not** edited — scoped, labeled deviation, not a policy change. All other threat-model assumptions (single-user, no adversarial peers, local-only device sync) remain in force.
- **One active pusher at a time.** Push-lease in `gcal_settings` — other devices stay idle until the active device releases or expires the lease. Prevents two devices each creating their own "Agaric Agenda" calendar on first connect, and prevents concurrent digest overwrites after that.
- **All-day events only.** Each digest event is a single all-day event on its date. No timed events, no timezone handling.
- **Push is driven from the materializer's downstream tap, not from inside command handlers.** Preserves `AGENTS.md` invariant 2 (CQRS split) — the op log stays append-only, and the GCal push reacts to already-materialized state via the `block:properties-changed` Tauri event bus + the `agenda_cache` / `projected_agenda_cache` tables.
- **New `gcal_agenda_event_map` and `gcal_settings` tables approved** (per `AGENTS.md` §"Architectural Stability"). Both are pure derived-state / configuration tables — no new op types, no new materializer queue, no new sync-protocol message, no new Zustand store.
- **New background Tokio task approved** (mirrors the `sync_daemon` lifecycle; **not** a new materializer queue).

**Architecture overview:**

New module `src-tauri/src/gcal_push/` — peer to `sync_daemon/`, launched on the same lifecycle. Module layout pinned so sub-items do not overlap:

```
src-tauri/src/gcal_push/
    mod.rs              — task lifecycle, configuration, Actor::GCalPush context (FEAT-5e)
    oauth.rs            — OAuth PKCE flow + token refresh (FEAT-5b)
    keyring_store.rs    — keychain-backed token storage with typed fallback (FEAT-5b)
    api.rs              — reqwest client + error taxonomy + calendar lifecycle (FEAT-5c)
    digest.rs           — pure (date, entries) → Event JSON (FEAT-5d)
    connector.rs        — event subscriber + per-date reconcile sweep (FEAT-5e)
    lease.rs            — push-lease acquisition / renewal (FEAT-5e)
    models.rs           — sqlx row structs for gcal_agenda_event_map + gcal_settings (FEAT-5a)
    tests/              — per-file tests, shared fixtures
src-tauri/src/commands/
    gcal.rs             — thin Tauri command wrappers consumed by FEAT-5f
```

The connector reads from the reader pool for its diff-and-push loop; it never writes to the op log. It writes to `gcal_agenda_event_map` / `gcal_settings` via a writer connection solely for its own derived state.

**Data source — what "an agenda entry" is:**

The connector does **not** write its own filter logic. It consumes `list_projected_agenda_inner(start_date, end_date, limit=500)` (already implemented in `src-tauri/src/commands/agenda.rs`), which returns `Vec<ProjectedAgendaEntry { block, projected_date, source }`:

- Already excludes `deleted_at IS NOT NULL` (via `agenda_cache` JOIN).
- Already excludes `is_conflict = 1` (agenda cache is populated only for the canonical block).
- Already excludes DONE / CANCELLED repeat occurrences that fall after the `repeat-until` / `repeat-count` end condition.
- Already includes projected future occurrences of repeating blocks within the window — so there is no repeat-expansion logic at the push layer.
- Template-page filtering: `agenda_cache` only rows from blocks whose root page is not marked `template` (if the current query does not already filter this, FEAT-5a adds the `NOT EXISTS (SELECT 1 FROM block_properties WHERE block_id = page_root_id AND key = 'template')` clause — verify during implementation and add if missing).

This means FEAT-5d and FEAT-5e are genuinely simple: they accept the projected entries as-is and format them.

**Data model (defined in FEAT-5a):**

- `gcal_agenda_event_map(date TEXT PRIMARY KEY, gcal_event_id TEXT NOT NULL, last_pushed_hash TEXT NOT NULL, last_pushed_at TEXT NOT NULL)` — **keyed by date, not by block**. At most `window_days` rows in steady state (default 30). Simple, dense, small.
- `gcal_settings(key PRIMARY KEY, value, updated_at)` — KV for `calendar_id` (the Agaric-owned calendar), `privacy_mode` (`full` / `minimal`), `window_days` (default `30`), `push_lease_device_id`, `push_lease_expires_at`, `oauth_account_email` (display only — token is in keychain). OAuth tokens live in the OS keychain, **not** in this table.
- FK to `blocks(id)` is **not** required (the map is date-keyed, and block deletion's effect is picked up by the next agenda query → hash changes → digest re-pushed).

**Event content (FEAT-5d), two privacy modes:**

- `full` (default):
  - Summary: `Agaric Agenda — <Weekday> <Mon DD>`, e.g. `Agaric Agenda — Tue Apr 22`.
  - Description: one line per entry, grouped by source (`DUE`, `SCHEDULED`, `PROPERTY`) with a blank-line separator. Each line: `[  ] <PageTitle> › <block content (first 80 chars)>` with state markers — `[ ]` TODO, `[/]` DOING, `[✓]` DONE, `[✗]` CANCELLED, `[~]` no todo state. Tags appended: `  #tag1 #tag2`. Description capped at 4096 chars (GCal limit is 8192; we leave headroom). If the date has no entries, the event is **deleted** rather than left with an empty description.
- `minimal`: summary = `Agaric Agenda — <date> (N entries)`. Description = empty. For users who share their "Agaric Agenda" calendar publicly.

**Sync cycle (FEAT-5e):**

1. Listener: every `block:properties-changed` event is classified. If its `changed_keys` intersects `{due_date, scheduled_date, todo_state, repeat, repeat-until, repeat-count, priority, title_or_content}`, compute the set of dates potentially affected: for a property change on a block, that is `{old_value, new_value} ∩ [today, today + window_days]`. Mark those dates dirty in an in-memory set.
2. Debounce: dirty-set is flushed 500 ms after the last addition, or immediately if the flush timer is already running and >1 s has elapsed.
3. For each dirty date:
   - Query `list_projected_agenda_inner(date, date, 500)`.
   - Compute `hash = blake3(canonicalized_entries_json)`.
   - Compare against `gcal_agenda_event_map.last_pushed_hash`.
   - If changed:
     - If entries is empty AND a map row exists → `delete_event`, delete map row.
     - If entries is empty AND no map row → skip.
     - If entries is non-empty AND no map row → `insert_event`, insert map row.
     - If entries is non-empty AND map row exists → `patch_event`, update map row's hash + timestamp.
4. 15-minute reconcile ticker: for every date in `[today, today + window_days]`, run step 3 unconditionally. Safety net for missed events, crash recovery, and window-boundary rollover at midnight.

**Rate limiting:**

- Coalesce `block:properties-changed` events within the 500 ms debounce window — prevents thrashing on drag-drop or bulk retitle.
- Google Calendar API quota: 500 queries / 100 s / user. Connector holds a token-bucket rate limiter (10 qps sustained, 25-burst). In practice the per-date model is well under quota — worst case at 30-day window × reconcile is 30 queries, already below burst.
- `429 Too Many Requests` → honor `Retry-After` verbatim.
- `5xx` → exponential backoff (reuse `SyncScheduler` shape from `sync_daemon/`, ceiling 5 minutes).
- `401 Unauthorized` → token revoked; disable the push toggle, clear the keychain entry, emit Tauri event `gcal:reauth_required`. Do NOT retry.
- `403 Forbidden` (insufficient scope / billing / calendar deleted out from under us) → log, disable, emit `gcal:push_disabled`. Do NOT retry.
- `404 Not Found` on the dedicated calendar → user deleted "Agaric Agenda" manually in GCal; next connect re-creates it. Clear all map rows.
- `404 Not Found` on a specific event → treat as "user deleted it"; clear the map row for that date, let the next push re-create.
- `400` / `409` → log as `AppError::Gcal::InvalidRequest`; do NOT retry.

**Queue durability:** in-memory only. The 15-minute reconcile sweep is the durability safety net — on restart, it re-hashes every date in the window and pushes any drift. A crash mid-push delays at most one date's update by ≤15 minutes.

**Midnight rollover:** the reconcile ticker is anchored to wall-clock; when local midnight passes, the new day's date enters the window and the old tail date leaves. Past-date events stay in GCal as historical records (no back-delete at window exit).

**Multi-device push-lease (FEAT-5e):**

- `gcal_settings.push_lease_device_id` = device currently authoritative. Renewed every 60 s, 180 s expiry.
- On startup: check lease; if expired or absent, CAS-claim via a single-row UPDATE guarded by `WHERE value IS NULL OR updated_at < ?`. If CAS fails, stay idle and re-check every 60 s.
- The lease is especially important **before** first connect: it prevents two devices each calling `calendars.insert` and creating two "Agaric Agenda" calendars on the same Google account.

**Disconnect cleanup (FEAT-5f):** On "Disconnect Google Calendar", open a modal with two choices: *"Keep the Agaric Agenda calendar"* (default — clears tokens + map rows only; the calendar + events remain in GCal) or *"Delete the Agaric Agenda calendar"* (one `calendars.delete` call — everything gone in one shot, because Agaric owns the whole calendar). Never silently mass-delete.

**Testing bar (per `AGENTS.md` §Testing Conventions + `PROMPT.md` §3):**

Each sub-item's verification is stated in its own entry. Global invariants:

- Happy-path + error-path tests for every exported Rust function / exported component.
- Exact-count assertions (`assert_eq!`, never `>=`).
- No silent `.catch(() => {})`; errors go through `logger.warn` / `logger.error` or `AppError`.
- `axe(container)` a11y audit on FEAT-5f.
- Property tests on FEAT-5d's pure digest function.
- IPC-rejection fallback tests on every `invoke` call in FEAT-5f.

**Open questions — recommended answers accepted as defaults unless the pre-implementation session overrides:**

- Window size → **30 days forward** (matches the projected-agenda default horizon). User-configurable in Settings, range `[7, 90]`.
- Debounce window → **500 ms**.
- Reconcile interval → **15 minutes**.
- Description character cap → **4096 chars**. If a single date has enough entries to exceed this (rare), truncate with `… and N more in Agaric` as the last line.
- Privacy default → `full` (user flips to `minimal` if they share the calendar publicly).
- Disconnect default action → "Keep the Agaric Agenda calendar".
- On `keyring` unavailable (Linux headless) → log warning, disable push, surface Settings error. Do **NOT** fall back to plaintext file storage.
- OAuth scope → `https://www.googleapis.com/auth/calendar` (required for `calendars.insert` to create our dedicated calendar; the narrower `calendar.events` is not sufficient). Confirm during FEAT-5b.
- Client ID → public desktop-OAuth client baked into the binary (standard for desktop OAuth; not a secret).
- Calendar name → `Agaric Agenda` (literal). Color hint: GCal palette index 5 (green) by default; user can re-color in GCal UI, we do not re-assert.

**Dependencies and coupled-stack note:**

New runtime crates:

- `oauth2` — PKCE flow helper. Match its TLS backend to the rest of the repo (`rustls`, not `native-tls`) via feature flags.
- `keyring` — cross-platform OS keychain (Secret Service / macOS Keychain / Windows Credential Manager). Pick the minimum per-platform backend features; avoid pulling the pure-Rust fallback.
- `tauri-plugin-oauth` — Tauri-side OAuth callback handler. Per `AGENTS.md` §"Coupled Dependency Updates", any Tauri plugin must move with the rest of the Tauri stack in one commit.
- `secrecy` — wrapper type (`Secret<String>`) for OAuth access + refresh tokens. Auto-redacts in `Debug`; forces explicit `.expose_secret()` to read. Cheap insurance against accidental token leakage through `tracing::instrument` spans, `AppError` chains, or `logger.warn` serialization. ~tiny crate, zero ongoing maintenance.

New dev-dep:

- `wiremock` — HTTP mock server for FEAT-5b / 5c / 5e tests. No existing alternative in the repo's dev-deps.

**Explicitly rejected dependencies (do not re-propose in later sessions without a strong new reason):**

- `google-calendar3` / `google-apis-rs` — auto-generated Google Calendar client. Pulls tens of thousands of lines of generated code for the 6 endpoints we use; couples us to `yup-oauth2`'s OAuth model which fights `tauri-plugin-oauth` for ownership of the loopback callback. The hand-rolled `api.rs` in FEAT-5c is ~200 readable lines — that is the right size.
- `yup-oauth2` — de-facto Rust Google OAuth client. Wants to own the full flow including its own local HTTP listener, which conflicts with `tauri-plugin-oauth`. `oauth2` crate + `tauri-plugin-oauth` is the clean split.
- `reqwest-middleware` + `reqwest-retry` — our retry is **per-error-class** (`401` → reauth event, `403` → push-disabled, `404` → drop map row, `429` → `Retry-After`, `5xx` → backoff), not generic transient-failure retry. Middleware libraries do not model class-specific action well, and we are already reusing `SyncScheduler` from `sync_daemon/`.
- `governor` / `leaky-bucket` — token-bucket rate limiter. We have exactly one fixed rate limit (10 qps / 25-burst); a `VecDeque<Instant>` in ~30 lines is more readable than a dep. Skip unless a second rate limiter lands elsewhere.
- `tower` / `tower-http` — not used elsewhere in the repo; introducing a middleware paradigm for one module is outsized.
- `mockall` — repo pattern is manual trait-based test doubles. Consistent with `AGENTS.md` "follow existing patterns".
- `chrono-tz` — v1 is all-day events only. Only relevant to the (unplanned) v3 timed-events phase.

**Feature-flag alignment (not a new dep, but in scope for FEAT-5c):**

Current `Cargo.toml`:

```toml
reqwest = "0.13.2"
```

Uses default features (`native-tls` backend). The rest of the repo is rustls-everywhere (`rustls`, `tokio-rustls`, `tokio-tungstenite` with `rustls-tls-native-roots`, sqlx on rustls). FEAT-5c aligns to:

```toml
reqwest = { version = "0.13.2", default-features = false, features = ["rustls-tls-native-roots", "json", "http2"] }
```

Consistent with MAINT-87's past pruning of unused sqlx backends (single TLS stack at link time, smaller binary).

**Already in `Cargo.toml` — reuse, do not duplicate:**

| Need | Existing crate |
|---|---|
| Error enum derives + `From` impls | `thiserror 2.0.18` (runtime) |
| Property tests | `proptest 1.11.0` (dev) |
| JSON snapshot tests (with redactions for timestamps / event IDs) | `insta 1.47.0` with `yaml` + `redactions` (dev) |
| Digest content hash | `blake3 1.8.3` (runtime) |
| Date + RFC 3339 wire format | `chrono 0.4.44` with `serde` (runtime) |
| `#[instrument(skip(token), err)]` pattern | `tracing 0.1.44` with `attributes` (runtime) |
| Multi-threaded materializer-style harnesses | `tokio` dev-deps already include `rt-multi-thread` + `test-util` |
| Temp DB fixtures | `tempfile 3.27.0` (dev) |

**Rollout phases:**

1. **v1 — Desktop daily-digest push.** FEAT-5a → FEAT-5b → {FEAT-5c, FEAT-5f} → FEAT-5e (with FEAT-5d landing independently).
2. **v2 — Android support.** FEAT-5g (requires its own design approval before work starts).
3. **v3 — Per-task events / timed agenda.** Explicitly NOT planned. The daily-digest model is the answer to "how the agenda shows up in GCal", and per-task mirroring was considered and rejected.

**Implementation DAG (v1):**

```
5a ──┐
     ├──▶ 5b ──┬──▶ 5c ──┐
     │        └──▶ 5f    ├──▶ 5e
5d ──┴───────────────────┘
```

First wave (parallel): `5a` + `5d`. Second wave: `5b`. Third wave (parallel): `5c` + `5f`. Fourth wave: `5e`.

**Cost:** L — spans one new backend module (~8 files), one new Settings tab, 4 new runtime crate deps + 1 new dev-dep, one migration, ~30 tests (Rust + frontend). Realistic estimate: **1–2 focused sessions** for v1 (a schema + digest + settings-UI session, then OAuth + API + connector). The daily-digest model is roughly 30–40 % less code than the rejected per-task shape.

**Status:** IN PROGRESS — v1 (FEAT-5a..FEAT-5i, desktop daily-digest push: schema + OAuth + API client + digest + settings tab + connector + DirtyEvent materializer hook + local-command DirtyEvent producer) landing incrementally. v2 (FEAT-5g, Android) DEFERRED pending separate design approval. v3 (per-task / timed events) explicitly NOT planned.

### FEAT-5g — GCal: Android OAuth + background connector (DEFERRED — design sketch only)

Part of the FEAT-5 family. **Not scheduled.** Blocked on explicit design-review approval before any code lands.

**Why this is filed and not done:**

- `tauri-plugin-oauth` on Android needs investigation — its current implementation targets loopback HTTP listeners, which Android sandboxes.
- `keyring` has no Android support; token storage would need to switch to Android Keystore via a JNI bridge or a Tauri-side secure-storage plugin.
- The `gcal_push::connector` task lifecycle on Android needs to survive Doze / battery-saver — either WorkManager periodic task (≥15 min min interval, may miss pushes) or an Android foreground service with a persistent notification (always-on, user-visible).
- Rate limits + offline durability on mobile are different shapes than desktop — though the daily-digest model makes this easier (at most ~30 ops per full resync, well under quota).

**Design questions to resolve before scheduling:**

- Loopback OAuth vs. Custom Tabs + PKCE + App Link callback — which does `tauri-plugin-oauth` support on Android today?
- Keystore-backed token store — existing Tauri secure-storage plugin, or custom JNI?
- Connector scheduling — foreground service (user-visible, always-on) or WorkManager periodic (may skip pushes under Doze)? For the daily-digest model, WorkManager's ≥15 min cadence is actually acceptable and matches the desktop reconcile interval — event-driven updates are a bonus, not a requirement.
- Re-auth UX when the user clears app data — acceptable, or do we need to export-and-reimport tokens?

**Cost:** L — 2–3 sessions minimum after design approval.

**Status:** DEFERRED. Do NOT start without an explicit design-review session that resolves the four questions above.

### FEAT-11 — Adopt `tauri-plugin-notification` (OS notifications for due tasks / scheduled events)

**Problem:** The app has agenda + due dates + scheduled dates + repeat properties + projected agenda + the Google Calendar push connector (FEAT-5), but zero OS-level notification path. A user with "buy groceries — DUE 09:00" cannot be notified by the OS unless the GCal push has already fired and their calendar app shows it. Org-mode / Logseq users expect "10 minutes before scheduled" and "due now" to surface as native notifications.

**Fix:** Adopt `@tauri-apps/plugin-notification` + `tauri-plugin-notification`. New backend module `src-tauri/src/notifier/mod.rs` schedules notifications based on `due_date` + `scheduled_date` + property events from the materializer (analogous to `gcal_push::DirtyEvent`). Reuses the existing `agenda_view` queries to find blocks within the next-24h window on boot and on every materialize commit. Frontend: a Settings tab toggle + per-property filter. Mobile permissions: request `POST_NOTIFICATIONS` on Android 13+ via the plugin's permission API. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** L — design (which events fire? how to dedupe? snooze semantics?), backend scheduler (~6 files), one Settings sub-tab, mobile permission flow, ~25 tests.
**Risk:** M — wrong-time notifications and notification spam are both real failure modes; needs careful dedupe and "do not re-fire on materialize replay" guard.
**Impact:** L — closes a recognised feature gap with Org-mode / Logseq parity; especially valuable on mobile where the user is unlikely to have the app foregrounded when a task is due.

## MAINT — Maintenance / cleanup

### MAINT-111 — MCP server hand-rolls JSON-RPC 2.0 framing; evaluate `rmcp` (official Rust MCP SDK)

**What:** `src-tauri/src/mcp/server.rs` (~492 LOC) implements line-delimited JSON-RPC 2.0 over the Unix-domain socket / Windows named pipe by hand:

- `make_success(id, result)` / `make_error(id, code, message)` response builders (lines ~127–145).
- `parse_request(line)` — manual shape validation (object? `method` field? `id` field?) with its own `ParsedRequest` / `IncomingRequest` / `IncomingNotification` enums (lines ~167–209).
- Method dispatch — `handle_initialize`, `tools/list`, `tools/call`, `notifications/initialized`, hard-coded JSON-RPC error codes (`JSONRPC_PARSE_ERROR` … `JSONRPC_RESOURCE_NOT_FOUND`).
- No `jsonrpc-core` / `jsonrpsee` / `rmcp` crate in `Cargo.toml`; everything is `serde_json::Value` + `json!` macros.

**Alternative:** `rmcp` (https://crates.io/crates/rmcp) is the official Rust Model Context Protocol SDK published by the `modelcontextprotocol` organisation. It supports **both** client and server roles over stdio (matching the MCP spec's subprocess framing that `agaric-mcp` forwards verbatim), provides typed tool / prompt / resource registration, automatic JSON-RPC 2.0 framing, and error-code mapping. `jsonrpsee` is an alternative for generic JSON-RPC but is HTTP/WS-oriented — `rmcp` is the more direct fit.

**Why this is only a "spike", not an immediate replace:**

- The `mcp/` module is ~2.4k LOC total and already has its own actor (`actor.rs`, 323 LOC), registry (`registry.rs`, 873 LOC), activity ring (`activity.rs`, 823 LOC), and last-append tracker (`last_append.rs`, 135 LOC). `rmcp`'s macro-driven tool model needs to coexist with the existing `ToolRegistry` trait and the FEAT-4d activity-feed plumbing.
- `agaric-mcp` ships as a separate binary; the migration affects the external stdio surface.
- `rmcp` is still pre-1.0 and evolving.

**Suggested spike:** wire one read-only tool (e.g. `search_blocks`) through `rmcp`'s server API while keeping the rest on the hand-rolled path. Measure:

1. How much of `server.rs` collapses (dispatch, framing, error mapping).
2. Whether `rmcp`'s tool-registration model can be adapted over the existing `ToolRegistry` trait without losing the activity-feed emission point.
3. Spec-conformance delta — does `rmcp` handle protocol-version negotiation, `tools/listChanged` notifications, or other MCP features that `server.rs` currently stubs?

If the adapter is clean, estimate a ~300–500 LOC reduction in `server.rs` with better forward-compatibility with MCP spec revisions. If `rmcp` wants to own the registry, abandon — the current code is well-tested and not a maintenance burden.

**Cost:** M (2–8h for the spike; full migration would be L if pursued).
**Risk:** M — external binary surface, coexistence with existing actor + activity-feed patterns.
**Impact:** M (conditional on spike outcome) — reduces framing boilerplate and tracks the MCP spec upstream rather than reimplementing it.

### MAINT-113 — `ConflictFreeBlockId` newtype to lift invariant #9 into the type system

**What:** AGENTS.md "Key Architectural Invariants" #9 reads:

> Recursive CTEs over `blocks` must filter `is_conflict = 0` in the recursive member, and bound `depth < 100` to prevent runaway recursion on corrupted data. Conflict copies leak into results otherwise.

This invariant is currently enforced by code review + grep + one-line comments. It is baked into **220 `is_conflict = 0` SQL occurrences across 70 source files** (plus 3 more in `migrations/`). Every new query touching `blocks` must remember to add it.

**Alternative design:** Split the `BlockId` primitive into two types:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct BlockId(String);        // raw — may refer to a conflict copy or deleted block

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ActiveBlockId(String);  // materialised AND is_conflict = 0 AND deleted_at IS NULL
```

Query helpers that return "active" blocks (`list_children`, `get_descendants`, `list_page_links`, every recursive CTE wrapped behind a Rust fn) return `Vec<ActiveBlockId>`. Query helpers that accept only active input take `&ActiveBlockId`. Conversion `BlockId → ActiveBlockId` goes through a single checked gate (`verify_active(&BlockId) -> Result<ActiveBlockId>`) that runs the `is_conflict = 0 AND deleted_at IS NULL` predicate exactly once. Recursive CTEs hidden behind these helpers keep their `AND is_conflict = 0` in SQL — the newtype just prevents callers from accidentally feeding a raw `BlockId` into a path that assumes active.

**Why this is a LOW-priority refactor:**

- The invariant is already documented (AGENTS.md #9), already tested (the `block_tag_inherited` materialised cache has an oracle CTE that verifies the filter is honoured), and already flagged by review (session logs show "missing `is_conflict = 0`" is caught before merge).
- No shipped HIGH/CRITICAL bug traces back to a missed filter in the last ~50 sessions. The tension is correctness-by-convention vs. correctness-by-types, not correctness vs. incorrectness.
- Scope is genuinely large — 220 SQL sites are the *floor* (each one lives in a function with a Rust signature); the real work is touching **every** producer/consumer of `BlockId` and deciding whether it returns raw or active. Honest estimate: 70 files, hundreds of function signature changes, a `specta`-bindings ripple to the frontend (extra TS type), and a round of test fixture updates.
- The serde wire format must stay `String` (both directions) so sync + IPC aren't affected — handled with `#[serde(transparent)]`.

**Do not take this on a deadline.** Land only as opportunistic cleanup — e.g., when a specific module is already being rewritten for another reason, convert its signatures over and leave the rest of the codebase on `BlockId` for another session. The existing `is_conflict = 0` + `depth < 100` convention is **not broken**; it is **not elegant**.

**Cost:** L (8h+ at minimum; realistically 2–4 sessions if done wholesale).
**Risk:** M — pervasive API change. Sync / MCP / specta bindings must round-trip identically. Mixing raw and active block IDs in a single data structure (e.g., `BlockTreeNode` with both active children and "recently-deleted" preview siblings) needs explicit policy.
**Impact:** M (if shipped) — eliminates an entire class of "forgot to filter conflicts" bugs at compile time. Invariant #9 in AGENTS.md could reference the type instead of a prose rule.

**Decision:** Defer indefinitely. Revisit only if a future `is_conflict = 0` miss ships a user-visible regression. Keep in REVIEW-LATER as a filed design note so it is not reinvented from scratch next time.

### MAINT-114 — Consolidation audit of `.github/workflows/`

**What:** Four workflow files today:

| File | Trigger | Jobs |
|---|---|---|
| `.github/workflows/_validate.yml` (135 LOC) | `workflow_call` | prek-equivalent (lint + fmt + clippy + nextest + vitest + playwright + sqlx offline check + MCP smoke) |
| `.github/workflows/ci.yml` (288 LOC) | push (non-tag) + PR | calls `_validate.yml` → desktop build matrix (ubuntu / windows / macos) + android aarch64/x86_64 build |
| `.github/workflows/release.yml` (~450 LOC) | push `v*` tag | calls `_validate.yml` → verify-version → desktop build matrix + sign + android APK + draft GitHub Release |
| `.github/workflows/release-tag.yml` (78 LOC) | `workflow_dispatch` only (`-f version=…`) | runs `scripts/bump-version.sh --commit --tag --push`; the tag push then re-triggers `release.yml` |

The initial one-line recommendation was "4 → 2 (validate + release)". On inspection that is too aggressive. `ci.yml` and `release.yml` have genuinely different reasons to exist (per-push non-tag build vs. per-tag signed-release pipeline), and `release-tag.yml` is a thin entry-point wrapper around `bump-version.sh` that exists so the maintainer does not have to type the bump + tag + push dance manually.

**Realistic consolidation wins (ranked by ROI):**

1. **Fold `release-tag.yml` into `release.yml` as a `workflow_dispatch` job** — 4 → 3. The bump-version step would sit above the build matrix, gated by `if: github.event_name == 'workflow_dispatch'`; the build matrix remains tag-triggered. Saves one file, removes the "tag push re-triggers a different workflow" indirection. Mild downside: `release.yml` grows by 78 LOC, and a dispatched version bump run that fails before the tag push no longer leaves a small, focused log (failure appears inside the big Release file). Probably worth it, but not huge.
2. **Keep `_validate.yml` as reusable** — already optimal. Called by both ci.yml and release.yml, avoids duplicating 135 LOC of setup. Leave alone.
3. **Do NOT merge `ci.yml` into `release.yml`** — the build matrix would have to be double-gated (`if: github.event_name == 'push' && !startsWith(github.ref, 'refs/tags/')` etc.), artifact upload names would conflict between "per-push smoke bundle" and "signed release bundle", and the signed-release path needs secrets that per-push builds must not have access to. The current split is a principled least-privilege boundary; collapsing it would require narrower secret scoping per step, which is more complex than the current file split.

**Proposed outcome:** Attempt 4 → 3. Only commit if the merged `release.yml` is not longer than `ci.yml` + `release.yml` + `release-tag.yml` combined, AND the `workflow_dispatch` path is at least as discoverable in the GitHub Actions UI as the standalone "Release Tag" entry. Otherwise abandon — a tidy file split is worth more than a tidy file count.

**Cost:** S–M (spike ~2h; full migration including docs-drift checks ~4h).
**Risk:** Low-to-medium — release pipeline is load-bearing. Test the merged workflow by dispatching against a throwaway tag (`0.0.0-test-consolidation`) on a fork or a draft release.
**Impact:** S — one fewer file to navigate, slight simplification of the "how do I cut a release?" mental model. Not pressure relief.

### MAINT-116 — `applyContentEdit` drops `notifyUndoNewAction` + missing `setBlockProperty` store action

**What:** `src/hooks/useBlockSlashCommands.ts:131-145` defines a local `applyContentEdit` that calls `editBlock(...)` directly (L137) and `pageStore.setState(...)` directly (L138-140), bypassing the store's canonical path `src/stores/page-blocks.ts:edit` at L384-405 which does **both** rollback on failure (L394-401) AND `notifyUndoNewAction(rootParentId)` on success (L392). Consumers (`handleHeading` L194-198, `handleCallout` L200-203, `handleNumberedList` L205-208, `handleDivider` L210-212) none of them call `notifyUndo` afterwards, so these four slash commands silently leave the redo stack uncleared — Ctrl+Shift+Z after one of them replays stale history. This is correctness-adjacent, not purely a refactor.

At the same time, **8+ sites across 4 hooks** reach into `pageStore.setState` directly to update per-block properties with optimistic-update + revert + `useUndoStore.getState().onNewAction(rootParentId)`:
- `src/hooks/useBlockProperties.ts:68-70 / 78-80 / 109-111 / 119-121` (4 sites for todo_state / priority).
- `src/hooks/useBlockSlashCommands.ts:172-175 / 186-189` (2 more for todo_state / priority via `handleTodoState` / `handlePriority`).
- `src/hooks/useBlockDatePicker.ts:90-92 / 119-121` (2 sites for due_date / scheduled_date).
- `src/hooks/useCheckboxSyntax.ts:58` (1 site).

The page-blocks store action list at `src/stores/page-blocks.ts:50-81` declares 10 actions; none are `setBlockProperty`.

**Fix:** Add `setBlockProperty(blockId, key, value)` to `createPageBlockStore`. It wraps the IPC + optimistic setState + rollback + `notifyUndoNewAction` in one place. Fix `applyContentEdit` to route through `pageStore.edit` (which already notifies). Migrate the 8 per-hook setState copies. This is one commit; it (a) closes the redo-stack regression, (b) removes 8 duplication sites, and (c) makes the undo-contract uniform for all per-block mutations.

**Cost:** S for the store-action addition; M for the migration.
**Risk:** Low-to-medium — undo semantics change for heading/callout/numbered-list/divider commands. Test with `useUndoShortcuts` + `onNewAction` mocks to confirm redo stack is cleared after each.
**Impact:** M — closes a real correctness regression (silent) AND removes ~8 duplicated patterns.

### MAINT-118 — Block-surface prop drilling (33 / 32 / 32 props across 3 layers)

**What:** `src/components/BlockListRenderer.tsx` / `SortableBlockWrapper.tsx` / `SortableBlock.tsx` each declare interfaces with **exactly 14 verbatim-shared callbacks** (`onNavigate` / `onSelect` / `onFocus` / `onBlur` / `onContentChange` / `onEnter` / `onBackspace` / `onTab` / `onShiftTab` / `onArrowUp` / `onArrowDown` / `onSplitBlock` / `onMergeBlock` / `onDelete`) and **4 verbatim-shared resolve functions** (`resolveBlock` / `resolveAttachment` / `resolveTagName` / `resolveLinkTarget`). Prop counts are 33 / 32 / 32. All 14 callbacks are threaded through all three layers unchanged. Every `BlockTree.tsx:821-855` render drills each prop individually to `<BlockListRenderer …>`.

**Fix:** Precedent exists — `src/stores/page-blocks.ts` already exposes `createPageBlockStore(pageId)` + `PageBlockContext` for per-page state. Mirror that shape for callbacks + resolvers:

```
// BlockSurfaceProvider wraps BlockListRenderer's children with:
const actions = useMemo(() => ({ onNavigate, onSelect, onFocus, … }), [...])
const resolvers = useMemo(() => ({ resolveBlock, resolveAttachment, … }), [...])
<BlockActionsContext.Provider value={actions}>
  <BlockResolversContext.Provider value={resolvers}>
    {children}
  </…>
</…>
```

Consumers read via `useBlockActions()` / `useBlockResolvers()` hooks. The wrapping components lose 18 props each; `React.memo(SortableBlock)` regains its value because child identity no longer churns on every parent re-render.

**Cost:** M — 3 components + 2 new hooks + ~40 consumer sites inside BlockTree / SortableBlock / StaticBlock.
**Risk:** Medium — re-render behaviour may shift; run BlockTree + SortableBlock tests with fake-timer traces.
**Impact:** M — the single most-felt cost on every block-surface ticket; also unblocks adding new block actions without drilling 3 layers.

### MAINT-119 — Decompose `src/components/JournalPage.tsx` (728L)

**What:** `JournalPage.tsx` inlines two large sub-components (`GlobalDateControls`, `JournalControls`) that can't be tested independently; includes page-create + template-load + block-insert logic at L170-270; and contains a **byte-identical duplicate fetch** at L356-369 ≡ L490-503 (both sub-components fetch the same calendar page-dates set on mount, so the IPC fires twice).

**Fix:**

1. Extract `src/components/journal/GlobalDateControls.tsx` (~120L) and `src/components/journal/JournalControls.tsx` (~120L).
2. Extract `src/hooks/useCalendarPageDates.ts` that wraps `listBlocks({ blockType: 'page', limit: 500 })` + the YYYY-MM-DD parse + highlightedDays memo, used by both sub-components.
3. Extract `src/hooks/useJournalBlockCreation.ts` covering `handleAddBlock` (page-create, template-load, block-insert, undo-notify).
4. Target JournalPage ≤300 lines (~300 shed).

**Cost:** M.
**Risk:** Low — refactor-only.
**Impact:** M — shrinks the third-largest component AND halves calendar-fetch IPC on journal mount.

### MAINT-120 — `useIpcCommand<T>` hook for settings/dialog components

**What:** Five components (`GoogleCalendarSettingsTab`, `AgentAccessSettingsTab`, `DeviceManagement`, `BugReportDialog`, `PairingDialog`) each carry their own copy of the "status-load + optimistic-update + revert + logger.error + toast.error" IPC pattern:

```ts
const loadStatus = useCallback(async () => {
  try { const result = await invoke<T>('get_x_status'); setStatus(result); setError(null) }
  catch (err) { logger.error('XTab', 'failed to load', undefined, err); setError(t('x.loadFailed')) }
  finally { setLoading(false) }
}, [t])

const handleToggle = useCallback(async (next: boolean) => {
  const previous = status
  setStatus({ ...status, enabled: next })     // optimistic
  try { await invoke('x_set_enabled', { enabled: next }); toast.success(...) }
  catch (err) { logger.error(...); setStatus(previous); toast.error(...) }
}, [...])
```

Only the command name and error message change between files.

**Fix:** `src/hooks/useIpcCommand.ts`:

```ts
export function useIpcCommand<T>(
  command: string,
  options?: {
    successMessageKey?: string
    errorMessageKey?: string
    onSuccess?: (result: T) => void
    onError?: (err: unknown) => void
  }
): { execute: (args?: Record<string, unknown>) => Promise<T>; loading: boolean; error: string | null }
```

Migrate the 5 components to consume it. Pairs naturally with MAINT-115 (`reportIpcError`) — share the same logger+toast helper inside `useIpcCommand`.

**Cost:** M (hook ~50 LOC; migration per-file).
**Risk:** Low.
**Impact:** M — removes the single biggest source of component-level boilerplate in the settings area.

### MAINT-122 — `createSpaceSubscriber()` helper + `useTauriEventListener()` hook

**What:** Two related duplications in the store / hook layers:

**(a) Per-space-switch subscriber — 3 stores, ~140 LOC of near-identical code:**

| File | Range | LOC | Pattern |
|---|---|---|---|
| `src/stores/navigation.ts` | L509-549 | 41 | `let prevSpaceKey; useSpaceStore.subscribe(...); newKey = state.currentSpaceId ?? LEGACY_SPACE_KEY; first-fire seeds on undefined` |
| `src/stores/journal.ts` | L187-256 | 70 | same shape |
| `src/stores/recent-pages.ts` | L140-168 | 29 | same shape |

**(b) Tauri `listen()` + cleanup boilerplate — 3+ hook variants:**

| File | Shape |
|---|---|
| `src/hooks/useSyncEvents.ts` | three `.then((unlisten) => { if (cancelled) unlisten(); else cleanups.push(unlisten) }).catch(...)` chains |
| `src/hooks/useDeepLinkRouter.ts:141-156` | file-local `attachListener(eventName, handler)` factor |
| `src/hooks/useBlockPropertyEvents.ts:40-60` | 4th shape with `unlistenPromise.then(fn => fn?.())` in cleanup |

The `useDeepLinkRouter` file-local factor is a tell that the extraction should live at the hooks layer.

**Fix:**

```ts
// src/stores/create-space-subscriber.ts
export function createSpaceSubscriber(
  storeKey: string,
  onChange: (newSpaceKey: string, prevSpaceKey: string | undefined) => void,
): Unsubscribe

// src/hooks/useTauriEventListener.ts
export function useTauriEventListener<T>(
  eventName: string,
  handler: (payload: T) => void,
  deps?: React.DependencyList,
): void
```

**Cost:** M — 2 helpers + 3+4 call sites.
**Risk:** Low — pure refactor, existing tests for each store's subscriber should keep passing.
**Impact:** M — removes ~140 LOC of verbatim duplication and makes adding a 4th space-scoped store / a 5th Tauri event listener a 1-line call.

### MAINT-123 — Mock drift: `trash_descendant_counts` missing from HANDLERS + typed HANDLERS

**What:** Diffing the IPC keys used by `src/lib/tauri.ts` (82 unique `invoke('<str>')` calls) against the `HANDLERS` map in `src/lib/tauri-mock/handlers.ts` (84 keys) yields:

- **Missing from mock:** `trash_descendant_counts` (invoked by `TrashView.tsx` via `tauri.ts:133`).
- **Mocks ahead of real coverage (mock stubs for unshipped commands):** `create_page_in_space`, `create_space`, `list_spaces` (the space-creation Phase 3 flow was stubbed ahead of time — no action needed, but worth documenting).

The root cause is that `HANDLERS` is typed `Record<string, Handler>` (`handlers.ts:38`) with `Handler = (args: unknown) => unknown` (`handlers.ts:30`) — stringly-keyed, no compile-time coupling to either `tauri.ts` wrappers or `bindings.ts` command names.

**Fix:**

1. Immediate: add a `trash_descendant_counts` handler to `HANDLERS` (the test suite for `TrashView.tsx` presumably exercises it via the real backend today, or fails silently in mock runs).
2. Structural: change `HANDLERS: Record<CommandName, Handler>` where `CommandName = keyof typeof commands` (imported from `bindings.ts`). Any new backend command → compile error in the mock file until a handler is registered.

Pairs with MAINT-125 (migrate `tauri.ts` to delegate to `bindings.ts.commands.*`). Once `tauri.ts` types its wrappers against `bindings.ts` AND `HANDLERS` types against `bindings.ts`, mock drift is caught at compile time across the stack.

**Cost:** S.
**Risk:** Low — type-level change.
**Impact:** M — eliminates the whole "silent mock drift" class.

### MAINT-124 — Collapse `src/App.tsx` (1436L) god component

**What:** `App.tsx` is the largest component in the tree at 1436L. It hosts:

- **20+ `useEffect`s** for independent concerns: global shortcut handlers × 5 (journal / global / space / tab / close-overlays), sync events, deep-link routing, draft recovery, priority-level loading, focus management, scroll restoration, view transitions, theme, online status.
- **10+ event listeners** registered/deregistered across effects.
- **5 dialog/modal open states** (`bugReportOpen`, `quickCaptureOpen`, `showNoPeersDialog`, `shortcutsOpen`, `bugReportPrefill`).
- **4 different async patterns in one file** (`void (async () => ...)()` IIFE, `.then().catch()`, `.then/.catch` inside callback, `async/await + try/catch`).
- **236-line inline sidebar tree** at L1159-1394 (`SidebarProvider` + `Sidebar` + header / menu / footer + `SidebarInset` + `TabBar` + `RecentPagesStrip` + `ScrollArea` + `ViewRouter`).
- **3 silent `.catch(() => {})`** at L935-939 (`w.unminimize().catch(() => {})`, `w.show().catch(() => {})`, `w.setFocus().catch(() => {})`). The outer `try/catch` at L931-942 does NOT rescue these — each inner `.catch` resolves the rejected promise to `undefined` so `await` succeeds. Direct AGENTS.md §Anti-patterns violation.

**Fix:**

1. Extract `useAppKeyboardShortcuts()` in `src/hooks/` — consolidate the 5 shortcut-handler effects into a single one. 5 effects → 1.
2. Extract `useAppDialogs()` — owns the 5 open states + their handlers.
3. Extract `<ViewDispatcher>` — the view-router switch that dispatches on `currentView`.
4. Extract `<AppShell>` — the sidebar tree and main content wrapper.
5. Fix the silent `.catch(() => {})` triplet by adding `logger.debug('App', 'best-effort window focus failed', { step }, err)` to each.
6. Standardize on `async/await + try/catch` for async patterns.

Target App.tsx ≤500 lines: boot gate, dialog mounts, the 4 extracted pieces, and composition.

**Cost:** L.
**Risk:** Medium — the file is load-bearing. Migrate incrementally, one extraction per commit, running the existing App.test suite and e2e shortcut tests between each.
**Impact:** L — biggest single-file cognitive-load reduction in the codebase.

### MAINT-125 — Migrate `src/lib/tauri.ts` to delegate to `bindings.ts` `commands.*`

**What:** `src/lib/tauri.ts` (1276L) hand-writes `invoke('<str>', { ... })` wrappers for every backend command. `src/lib/bindings.ts` (873L) is auto-generated by Tauri Specta (`@ts-nocheck` + Tauri Specta banner verified) and exports `commands.*` with fully typed signatures. Three spot-checks:

| Wrapper | `tauri.ts` site | `bindings.ts` site |
|---|---|---|
| `editBlock` | L92-94: `return invoke('edit_block', { blockId, toText })` | L17: `editBlock: (blockId, toText) => typedError<BlockRow, AppErrorSchema>(__TAURI_INVOKE("edit_block", { blockId, toText }))` |
| `deleteBlock` | L97-99 | L19 |
| `batchResolve` | L243 | L54 |

Same IPC command name, two wrappers. The compiler cannot verify `tauri.ts`'s command strings against `bindings.ts`. Every new backend command is added twice; command renames drift silently. Combined with the `HANDLERS` stringly-typed keys (MAINT-123), there is no end-to-end compile-time contract.

**Fix:** Stage migration — one PR per ~10 wrappers that replaces the raw `invoke('x', …)` body with `await commands.x(...)` (plus any shape translation needed). The public surface of `tauri.ts` stays identical; consumers don't change. Once all wrappers delegate, `tauri.ts` may become a very thin remapping layer or be deleted entirely if its consumers migrate to import `commands.*` directly.

Pair with MAINT-123 — both land as "typed end-to-end IPC contract" epic.

**Cost:** L (~80 wrappers × a few minutes each = 8h+ spread across multiple PRs).
**Risk:** Low-to-medium — surface is stable, but need to verify each wrapper's arg shape matches bindings (some wrappers reshape args).
**Impact:** M — kills the largest duplication source in `src/lib/` AND unlocks compile-time coverage for mock-drift (MAINT-123).

### MAINT-126 — Split `src/lib/i18n.ts` (2351L) by namespace

**What:** `src/lib/i18n.ts` is **2351 lines** — a single `const resources = { en: { translation: { … } } }` flat object with 800+ keys. `i18n.use(initReactI18next).init({ resources, lng: 'en', fallbackLng: 'en', ... })` at L2339-2346 hardcodes `lng` + `fallbackLng` to `'en'` with no language detector. This is single-locale today — the file size is purely a readability / merge-conflict problem, not a multi-locale one.

**Fix:** Split by namespace, not by locale:

```
src/lib/i18n/
├── index.ts          # i18next init + re-exports
├── common.ts         # cross-cutting
├── agenda.ts         # agenda.* keys
├── editor.ts         # editor.* + slash.* + picker.* keys
├── settings.ts       # settings.* keys
├── conflict.ts       # conflict.* keys
├── pairing.ts        # pairing.* keys
├── journal.ts        # journal.* keys
├── …
```

Do NOT add unused locales (no `es.ts`, no `fr.ts`) — single-locale stays. Purely a file-size / merge-conflict reduction. Each namespace file stays under ~300 lines.

**Cost:** M — mechanical split; largest file in the tree but each key is self-contained.
**Risk:** Low — test suite will catch any missing namespace reference.
**Impact:** S — the `src/lib/i18n.ts` PR conflict hotspot goes away.

### MAINT-127 — God-file decomposition (libs + stores + hooks)

**What:** Four files have grown well past the "thin orchestrator" threshold. All have banner comments or clear seams that map 1:1 to concrete extractions:

| File | LOC | Extraction targets |
|---|---|---|
| `src/stores/page-blocks.ts` | 718 | `planSplit` + `computeIndentedBlocks` + `findPrevSiblingAt` + `midpointPosition` at L116-277 are pure tree algorithms — extract to `src/lib/block-tree-ops.ts`. Factory body stays ≤500. |
| `src/stores/navigation.ts` | 549 | Tab engine (`tabs` / `activeTabIndex` / `tabsBySpace` / `activeTabIndexBySpace` state + `navigateToPage` / `goBack` / `replacePage` / `openInNewTab` / `closeTab` / `switchTab` actions + `selectTabsForSpace` / `selectActiveTabIndexForSpace` selectors) has drifted in from an unrelated concern. Move to `src/stores/tabs.ts`. Docstring L1-17 says "page routing and view management". |
| `src/lib/keyboard-config.ts` | 740 | Split into 4 files: catalog (`DEFAULT_SHORTCUTS` L17-549), TipTap key conversion (`configKeyToTipTap` L555-571), normalize/match (`normalizeKey` / `matchesShortcutBinding` / `matchesSingleBinding` L573-658), storage + conflict (`getCustomOverrides` / `setCustomShortcut` / `resetShortcut` / `resetAllShortcuts` / `findConflicts` L661-739). |
| `src/hooks/useGraphSimulation.ts` | 716 | 9 banner-comment sections at L39 / L58 / L112 / L278 / L325 / L361 / L516 / L603 / L617 mark the seams. Extract `useGraphZoom`, `useGraphWorkerSimulation`, `useGraphMainThreadSim`, `useGraphRenderElements`. |

**Cost:** L (can be split into 4 separate medium-effort PRs, one per file).
**Risk:** Medium — each file has its own test suite; migrate with tests passing between every commit.
**Impact:** L — four of the top-10 biggest files collapse to <500L each; graph simulation in particular regains reviewability.

### MAINT-128 — God-component decomposition batch

**What:** Nine components have grown well past the sibling-components + hook layer's "keep under 500L" norm, with concrete sub-pieces already visible in the code. All line counts validator-verified.

| Component | LOC | Concrete extraction target |
|---|---|---|
| `src/components/PageBrowser.tsx` | 961 | `PageBrowserRowRenderer` (3 row kinds already exist as fns); `PageBrowserHeader` (form + search + sort dropdown); `usePageBrowserGrouping` hook (`buildSinglePageBranch`, `buildMultiPageBranch`, `sortTopLevelUnits`); `usePageBrowserSort` hook (localStorage pref + sort callback). Target ≤300. |
| `src/components/BlockTree.tsx` | 899 | `useBlockLinkResolve` (cache + batch resolve at L336 + L401); `useBlockPropertiesBatch` (L424); `useBlockNavigateToLink` (60-line `handleNavigate` L539-597); hoist the 4 `*Ref` indirections (`handleBeforeCollapseRef` etc. L240-243) with their hooks. Target ≤500. Violates own "thin orchestrator" docstring. |
| `src/components/TrashView.tsx` | 788 | `useTrashFilter`, `useTrashMultiSelect` hooks; row renderer to sibling; 4 inlined `ConfirmDialog`s can move to siblings. Target ≤350. |
| `src/components/ConflictList.tsx` | 737 | Extract `useConflictFilters`, `useConflictSelection`; split 3 inline `ConfirmDialog`s to siblings. **Same commit removes the direct DOM-mutation anti-pattern at L287-300** where `item.setAttribute('role','option')` is called from a `useEffect` (React may overwrite on re-render; the comment at L287-289 admits the workaround). Target ≤350. |
| `src/components/SettingsView.tsx` | 620 | 9 tab panels currently rendered inline from one switch (L532-614). Extract to `src/components/settings/{General,Properties,Appearance,Keyboard,Data,Sync,Agent,GoogleCalendar,Help}Tab.tsx`. Lift `AutostartRow` (L188-298, 110L) + `QuickCaptureRow` (L299-441, 142L) to siblings. Add `useSettingsTab()` hook for localStorage+URL persistence. Target SettingsView.tsx ≤150. |
| `src/components/HistoryView.tsx` | 528 | `useHistorySelection` (wraps `useListMultiSelect` with HistoryView semantics); `useHistoryKeyboardNav`; `HistoryListView` presentational; `HistoryRevertDialog` + `HistoryRestoreDialog` siblings. Target ≤250. |
| `src/components/PropertyRowEditor.tsx` | 539 | **Explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L85** with a rationale that is invalidated by dispatching by `def.value_type` (text/number/date/ref/select → 5 parallel JSX subtrees). Split into 5 typed row editors + a dispatcher. The `biome-ignore` goes away. |
| `src/components/SortableBlock.tsx` | 469 | `useAttachmentCount` (L150-165); `usePropertyDefForEdit` (L220-265); `useBlockContextMenu` (context-menu + edit state L138-147); touch-long-press + swipe-to-delete remain. Target ≤250. |
| `src/components/backlink-filter/AddFilterRow.tsx` | 556 | **2.5× its parent `BacklinkFilterBuilder`** (218L). 14 state slots at L194-213 + 10 per-category JSX blocks. Extract one file per filter category; state slots move with their category. |

**Cost:** L (stagger per file — do NOT land in one PR).
**Risk:** Medium per file — most have test suites; run the matching test file between each commit.
**Impact:** L — the 9 most expensive maintainability hotspots in the component tree become composable.

### MAINT-129 — Duplication cleanup batch

**What:** A collection of pair-level duplications found by the whole-frontend review. Most are ≤50 LOC each; trivial individually, but the batch is worth tracking as one effort because they share the `.lib/` → `components/` move pattern.

**Byte-identical duplicates (delete one copy):**

- `renderKeys(keys: string): React.ReactNode` — `src/components/KeyboardSettingsTab.tsx:23-43` ≡ `src/components/KeyboardShortcuts.tsx:68-88`. Extract to `src/lib/render-keyboard-shortcut.tsx`.
- `formatSize(bytes: number): string` — `src/components/AttachmentList.tsx:26-30` ≡ `src/lib/attachment-utils.ts:22-26`. Delete local copy; import canonical.
- MIME icon map — `src/components/AttachmentRenderer.tsx:9-17` (`AttachmentMimeIcon`) ≡ `src/components/AttachmentList.tsx:49-57` (`MimeIcon`). Move to `src/lib/attachment-utils.ts` or a shared `MimeIcon` component.
- `dueDateColor(date)` — `src/components/BlockInlineControls.tsx:35-41` (exported) ≡ `src/components/AgendaResults.tsx:68-72` (local unexported). Both return the identical 3-branch switch today; drift risk. Move to `src/lib/date-utils.ts`.
- `formatDateISO(d: Date): string` — `src/components/BlockListItem.tsx:65-70` manually builds `yyyy-mm-dd` with `padStart`, duplicating `src/lib/date-utils.formatDate` (already `date-fns` backed, property-tested). Swap one-line usage.
- `relativeTime(isoString)` — `src/components/AttachmentList.tsx:32-46` (also hardcodes English — see UX-7 broader inventory) duplicates `src/lib/format-relative-time.ts`. `t` is already in scope at L60.

**Near-identical duplicates (extract helper):**

- `handleMergeWithPrev` L226-296 ≡ `handleMergeById` L298-361 in `src/hooks/useBlockKeyboardHandlers.ts` — two independent merge orchestrations with matching string literals (`'Failed to merge blocks (edit step)'`, `'Failed to revert edit after merge failure'`, `'blockTree.mergeBlocksFailed'`). ~70 LOC of duplicated revert logic. Collapse into one parameterised helper.
- 4 near-identical `fetch → filter → extractUlidRefs → batchResolve → setPageTitles` effects in `src/hooks/useDuePanelData.ts` (Overdue L167-214, Upcoming L218-280, `fetchBlocks` L283-354, Projected L357-430). Extract a shared async flow helper.
- Focus-ring + scroll-into-view + `biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset` triad in 6 list views (`LinkedReferences.tsx:245-265`, `UnlinkedReferences.tsx:245-265`, `HistoryView.tsx`, `PageBrowser.tsx`, `TrashView.tsx`, `ConflictList.tsx`). Extract `useFocusedRowEffect(focusedId, className)`.
- localStorage preference read/write/try-catch — 3 inconsistent variants (`src/components/DuePanel.tsx:57-86` with structured logger, `src/hooks/useAgendaPreferences.ts:16-34` with bare `/* ignore */`, `DeadlineWarningSection` a third shape). Extract `useLocalStoragePreference<T>(key, default)`.

**Cost:** M (~8h for the whole batch).
**Risk:** Low per pair; run tests between each.
**Impact:** M — removes ~500 LOC of duplication and makes each domain's next change a one-file edit.

### MAINT-130 — Dead code + naming + convention-drift batch

**What:** Low-risk cleanups that are individually trivial. Collected here to land as one opportunistic session.

**Dead code (all verified with `grep src/` excl. tests):**

- `src/components/EditableBlock.tsx:293` — stray `;('EditableBlock')` expression statement (leftover from a `displayName` refactor). Delete the line.
- `src/components/StaticBlock.tsx:32` — `export { getAssetUrl } from '../lib/attachment-utils'` — 0 production importers; consumers already import from `../lib/attachment-utils` directly.
- `src/components/EditableBlock.tsx:28` — `export { EDITOR_PORTAL_SELECTORS } from '@/hooks/useEditorBlur'` — 0 production importers; only `__tests__/EditableBlock.test.tsx:19` imports it from `../EditableBlock`. Fix the test import AND update `src/__tests__/AGENTS.md:616` doc drift that still points to "EditableBlock.tsx" as the location.
- `src/components/BlockInlineControls.tsx:29` — `PRIORITY_DISPLAY` constant, comment at L22-27 calls it "legacy" superseded by `priorityLabel()`. Only its own test imports it. Remove constant + the one test.
- `src/components/StaticBlock.tsx:33` — `export { renderRichContent } from './RichContentRenderer'` back-compat re-export. 8 production importers (TrashView, DuePanel, HistoryListItem, DiffDisplay, BacklinkGroupRenderer, ResultCard, ConflictTypeRenderer, BlockListItem) can be migrated to import from the canonical path.
- `src/components/QueryResult.tsx:21-26` re-exports (`SortDirection`, `compareValues`, `PropertyFilter`, `buildFilters`, `OPERATOR_SYMBOLS`, `parseQueryExpression`) — 0 production importers; tests use the canonical `hooks/useQuerySorting` / `lib/query-utils` paths. Delete the re-exports.
- `src/components/AgendaFilterBuilder.tsx:27-36` re-exports — **partial dead**: keep only `AgendaSortGroupControls` (consumed by `src/components/journal/AgendaView.tsx:13`); the other 4 symbols (`AgendaFilterDimension`, `ALL_DIMENSIONS`, `DIMENSION_OPTIONS`, `dimensionLabel`, `getTaskStates`) are dead in production.
- `src/editor/types.ts` — 22 of 23 `export function` builder helpers are only imported by tests (`pmEndOfFirstBlock` is the one with a production consumer at `useBlockKeyboardHandlers.ts:6`). Move the 22 to `src/editor/__tests__/builders.ts`; keep `pmEndOfFirstBlock` in `types.ts` or promote to its own tiny module.

**Naming / collision:**

- `src/components/BlockContextMenu.tsx` (floating menu, consumed by `SortableBlock.tsx:28`) and `src/components/block-tree/BlockContextMenu.tsx` (batch toolbar, consumed by `BlockTree.tsx:63`) — same symbol name, different components. Rename one (`BlockContextFloatingMenu` / `BlockBatchToolbar`). The one test file `__tests__/BlockContextMenu.test.tsx` tests the floating menu; batch toolbar is only exercised transitively via `BlockTree.test.tsx` — rename the floating menu's test file alongside.
- `src/hooks/use-mobile.ts` — sole kebab-case hook filename among 56 camelCase siblings. 7 non-test importers. Rename to `useIsMobile.ts`; update imports.
- `.helpers.ts` suffix on 3 files (`DonePanel.helpers.ts`, `GraphView.helpers.ts`, `journal/AgendaView.helpers.ts`). Adopt as a convention (and add to AGENTS.md) or migrate to `foo-utils.ts` in `src/lib/` like the rest of the codebase. Pick one.

**Convention drift:**

- `src/components/PageTitleEditor.tsx:21-25` — uses `[...].join(' ')` instead of `cn()`. Low-impact style.
- `src/components/TemplatesView.tsx:220-225` — uses `className={[...].join(' ')}`.
- `src/components/SpaceManageDialog.tsx:652` — `<DialogContent className="max-h-[85vh] overflow-y-auto">` — lone straggler after UX-208 migration. Wrap body in `<ScrollArea className="max-h-[85vh]">…</ScrollArea>`.
- `src/components/TemplatesView.tsx`, `src/components/PropertyDefinitionsList.tsx`, `src/components/SourcePageFilter.tsx` — hand-roll `<Input className="pl-9">` + absolute `<Search>` instead of the existing `SearchInput` primitive used by `TrashView`, `TagFilterPanel`, `AddFilterRow`.
- `src/components/ConflictList.tsx:287-300`, `src/components/LinkedReferences.tsx:251-265`, `src/components/UnlinkedReferences.tsx:250-265` — direct DOM mutation from `useEffect` (`item.setAttribute('role','option')`, `el.classList.add(...)`). React can overwrite on re-render. Move attributes to JSX props or use `ref` callbacks.

**Inconsistency fixes:**

- Three patterns for destructive-action confirmation: `PairingDialog` uses bespoke `ConfirmDialog`; `GoogleCalendarSettingsTab` uses Radix `AlertDialog`; `AgentAccessSettingsTab` + `DeviceManagement` have NO confirmation (direct IPC on disconnect / unpair). Create `<ConfirmDestructiveAction>` wrapper over `AlertDialog`; migrate all four.
- `src/hooks/useStarredPages` — extract so `PageBrowser` / `PageHeader` stop calling `toggleStarred()` (localStorage) directly with a `starredRevision` counter workaround.
- `src/editor/extensions/block-ref-picker.ts` is the odd picker out among 5 (no `addInputRule`, no `onCreate`, no `Commands` module augmentation — verified via 5-picker capability matrix). Users can type `[[foo]]` and auto-resolve via `BlockLinkPicker` but cannot do the same for `((foo))` even though the underlying node supports it. Add the missing three hooks.
- `src/editor/use-roving-editor.ts:280-281 / 340-342` — `BlockRefPicker.configure({ items: searchBlockRefsRef.current })` reads `.current` at configure time, so the ref is defeated; also allocates a fresh `async () => []` fallback on every render. Migrate to wrapper-closure pattern used by `TagRef.configure` at L309-313.
- Extract `createPickerPlugin(cfg)` factory for the shared `addProseMirrorPlugins` shell across all 5 pickers (~50-70 LOC/file of copied `try / await / logger.warn / command: { editor, range, props }` boilerplate). Keep per-picker `addInputRules` separate (they diverge — see the picker capability matrix).

**Cost:** M — individual items are all S, but the batch spans 20+ files.
**Risk:** Low — mechanical cleanups with existing tests.
**Impact:** M — removes entire categories of "did you notice X is dead?" / "which `BlockContextMenu` did you mean?" friction.

### MAINT-131 — Block-surface Tauri coupling

**What:** 8 presentational components in `src/components/` import functions from `src/lib/tauri` directly (`StaticBlock`, `EditableBlock`, `SortableBlock`, `BlockListItem`, `BlockPropertyEditor`, `BlockPropertyDrawer`, `ImageResizeToolbar`, `LinkEditPopover`). `AttachmentList` imports types only — acceptable. `BlockTree` is the orchestrator — acceptable.

**Notable double-IPC:** `SortableBlock.tsx:155` calls `listAttachments(blockId)` to compute the attachment-count badge, AND `StaticBlock.tsx:102` calls `useBlockAttachments(blockId)` which hits `listAttachments` at `useBlockAttachments.ts:35`. Because `StaticBlock` is the non-focused view for every block row on the page, every block fires its own `listAttachments` IPC on mount — **double IPC per block row**. At 50 blocks/page that's 100 attachment-count IPCs on mount.

**Fix:**

1. Backend: add `get_batch_attachment_counts(block_ids: Vec<String>) -> HashMap<String, u32>` mirroring the `json_each()`-backed batch patterns already used in `fts.rs` and `backlink/query.rs`. One IPC, all counts.
2. Frontend: `useBatchAttachmentCounts(blockIds)` hook that calls the batch IPC once per page mount; `SortableBlock` reads its count from that hook's map instead of firing per-block.
3. Wrap remaining per-IPC calls in hooks (`usePropertySave` already exists; add `useBlockReschedule` around `setDueDate` / `setScheduledDate`; `useLinkMetadata` around `fetchLinkMetadata`). Components become pure JSX + hooks, no direct `lib/tauri` imports.

**Cost:** L — 1 backend command + 1 hook + refactor of 8 components (probably 3 PRs).
**Risk:** Low — additive IPC, existing per-block calls can coexist during migration.
**Impact:** M — eliminates doubled IPC on every page mount AND enables isolated rendering (Storybook, unit tests w/o full mocks) for block-surface components.

### MAINT-132 — Consolidate hand-written recursive CTEs behind `block_descendants` macros

**What:** Four command files still hand-write recursive CTEs that should use (or extend) the existing `block_descendants.rs` macros:

- `commands/blocks/move_ops.rs:93-109` — ancestor walk for cycle detection before a move.
- `commands/blocks/crud.rs:99-110` — ancestor walk for depth-limit check on parent change.
- `commands/history.rs:51-64` — descendant walk for the DeleteBlock cascade (byte-for-byte mirror of `descendants_cte_active!()`).
- `commands/history.rs:72-81` — descendant walk for RestoreBlock cascade (mirror of `descendants_cte_standard!()`).

`block_descendants.rs:36-38` lists three documented call-sites that are intentionally inline; history.rs is **not** in that list.

**Why:** Every hand-written recursive CTE is a chance to forget AGENTS.md invariant #9 — `is_conflict = 0` in the recursive member and `depth < 100` to bound runaway recursion on corrupted data. Both hand-written descendant walks in history.rs currently carry the invariant, but that survives only as long as every copy-editor remembers it.

**Fix:**

1. Add an ancestor-walk macro family to `block_descendants.rs` (`ancestors_cte_active!()`, `ancestors_cte_standard!()`, parameterized the same way as the descendant variants).
2. Apply to `move_ops.rs` and `crud.rs`.
3. Migrate history.rs to the existing `descendants_cte_*!()` macros.
4. Optional stretch: factor `dag::find_lca`'s chain-walk loop (see MAINT-146 item c) to use a shared helper if the macro surface naturally covers it.

**Cost:** M (2–8 h) — macro authoring + 4 call-site migrations + integration tests to cover `is_conflict=1` subtrees for each migrated call.
**Risk:** Low — the existing macro pattern is well-established; every call site has an integration test today.
**Impact:** M — eliminates invariant #9 drift risk across the four cited sites and makes adding a fifth trivial.

### MAINT-137 — Extract `#[cfg(test)]` mega-blocks to sibling `tests.rs` files

**What:** Four of the largest backend files are mostly test code, making them harder to scan than necessary:

| File | Total lines | Production | Tests |
|---|---|---|---|
| `mcp/server.rs` | 3053 | ~915 | ~2138 |
| `mcp/tools_ro.rs` | 2138 | ~645 | ~1493 |
| `mcp/tools_rw.rs` | 1189 | ~449 | ~740 |
| `sync_files.rs` | 2393 | ~720 | ~1673 |

The established repo pattern elsewhere (`sync_daemon/tests.rs`, `sync_protocol/tests.rs`, `sync_net/tests.rs`, `materializer/tests.rs`) is to keep the production code in `foo.rs` and move the test module into a sibling `tests.rs` re-attached via `#[cfg(test)] mod tests;`.

**Fix:** Move each file's test block into a sibling `tests.rs`. One commit per file so CI cache invalidation stays bounded. No behaviour change.

**Cost:** S–M — mechanical per file; biggest one is `mcp/server.rs`.
**Risk:** Low — test-only move; any test-only helpers (`use super::*;`) are preserved by the pattern.
**Impact:** M — immediately halves the "what does this file do" scan time on the four largest files.

### MAINT-139 — Collapse `GcalClient` trait + `GcalApiAdapter`

**What:** `gcal_push/connector.rs:97-212` declares a `GcalClient` trait that mirrors every `GcalApi` method and a `GcalApiAdapter` that forwards each call; ~115 lines of forwarders that exist only so tests can substitute `MockGcalClient`. The two APIs have already drifted:

- `GcalApi::patch_event` returns `EventResponse`; the trait's `patch_event` returns `()` (adapter throws the response away).
- Each shape change requires 3 edits: `api.rs`, the trait, the adapter.

`connector.rs:957-996` defines yet another 40-line `ClientAdapter` trait impl **inside** `run_task_loop`, only because `run_cycle` is generic over `C: GcalClient` (Sized) while the outer task holds `Arc<dyn GcalClient>` (?Sized). This is architectural friction, not a real adapter.

**Fix (one of):**

- **(a)** Retire the trait + adapter entirely. `GcalApi` already supports a configurable base URL via `shared_client_with_base_url` — existing wiremock tests prove this. Port the connector tests to point at a `wiremock` instance and drop the `Mock*` machinery.
- **(b)** Keep the trait for dynamic-dispatch in the task loop, but have `GcalApi` itself `impl GcalClient` directly (no adapter). Kill the nested `ClientAdapter` inside `run_task_loop` by changing `run_cycle` to take `&dyn GcalClient`.

**Cost:** M — the test migration (a) or generics refactor (b) is the real work.
**Risk:** M — external test surface for the connector changes; run the full gcal integration suite after.
**Impact:** M — ~150 LOC gone and one fewer API surface to keep in sync.

### MAINT-142 — Split `tag_inheritance.rs` into `mod.rs` + `incremental.rs` + `rebuild.rs` + `tests.rs`

**What:** `tag_inheritance.rs` is 1324 lines and exposes ~8 top-level `pub async fn` (`apply_op_tag_inheritance` documented as "the" single entry point, plus 7 helpers). The documented single-entry-point invariant is not enforced by visibility — every helper is `pub`.

**Fix:**

1. Refactor into `tag_inheritance/` directory: `mod.rs` (dispatcher + re-exports), `incremental.rs` (per-op handlers), `rebuild.rs` (full-cache rebuild from snapshot-like state), `tests.rs` (#[cfg(test)] block). The macros file (`tag_inheritance_macros.rs`) is a sibling and stays where it is.
2. Demote every helper to `pub(crate)`; make `apply_op_tag_inheritance` the only `pub` surface.

**Cost:** M — straight-up file-level refactor; test module moves verbatim.
**Risk:** Low — no logic change; the call graph (only `materializer/handlers.rs` imports this module) is small.
**Impact:** M — readable seams for a critical subsystem; discourages new cross-helper coupling.

### MAINT-159 — `check-ipc-error-path.mjs` only enforces top-level `src/components/*.tsx`

**What:** The hook (`scripts/check-ipc-error-path.mjs` + `prek.toml:189`) requires every IPC-calling component to have an error-path test, but its file regex (`^src/components/([^/]+\.tsx|...)$`) only matches **top-level** files in `src/components/`. Subdirectories are out of scope:

- `src/components/agent-access/` — MCP status section, activity feed, session revert controls
- `src/components/journal/` — daily/weekly/monthly views, agenda results, drop zones
- `src/components/block-tree/` — TemplatePicker, batch-action toolbar, BlockContextMenu
- `src/components/backlink-filter/` — AddFilterRow
- `src/components/settings/` — (will exist after MAINT-128 splits SettingsView)

The script header explicitly documents this as a "HARD-NARROWED" scope with a deferred FOLLOW-UP. Today there's no signal that subdirectory components handle IPC rejection paths.

**Fix:**

1. Update `check-ipc-error-path.mjs` to walk `src/components/**/*.tsx` recursively.
2. Update `prek.toml:189` `files` regex to match the recursive pattern: `^src/components/.*\.tsx$|^src/components/__tests__/.*\.test\.tsx$`.
3. Run the hook locally; address whatever new gaps the recursive walk surfaces.

Land **after** MAINT-128 — the god-component split creates new subdirectories, and the new files all need error-path tests as part of MAINT-128 anyway.

**Cost:** S (15 min for the script + regex change; effort to fix exposed gaps depends on what surfaces).
**Risk:** Low.
**Impact:** M — closes a class of "IPC rejection silently swallowed" regressions in subdirectory components.

### MAINT-162 — ARIA role re-evaluation for list views (`role="listbox"` → `role="grid"`)

**What:** Two clusters of axe-rule disables paper over the same root cause:

- **`nested-interactive: { enabled: false }`** at ~20 sites:
  - `src/components/__tests__/PageBrowser.test.tsx:1880, 1908, 2183, 2214`
  - `src/components/__tests__/TrashView.test.tsx:851, 873, 1018, 1088`
  - `src/components/__tests__/ConflictList.test.tsx:447, 2087`
  - `src/components/__tests__/HistoryListItem.test.tsx:465`
  - `src/components/__tests__/StaticBlock.test.tsx:360, 440, 1447, 1529, 1574, 1608, 1686` (×7)
  - `src/components/__tests__/TagFilterPanel.test.tsx:919, 952`
- **`aria-required-children: { enabled: false }`** at `src/components/__tests__/PageBrowser.test.tsx:2187` (FEAT-14 mixed-mode list with options + tree-button rows)

Both clusters trace to the same architectural choice: `role="listbox"` + `role="option"` on rows that contain action buttons (star, delete, navigate, restore, purge, etc.). Per WAI-ARIA APG, options must be **atomic and non-interactive** — listbox keyboard semantics (arrow keys select, Enter activates the option) don't compose with nested action buttons. The nested buttons require manual focus/keyboard handling that AT users may not discover. The suppressions silence a real screen-reader-broken state.

The PageBrowser case is the strongest violation: FEAT-14 mixes `role="option"` rows (flat pages) with `PageTreeItem` button rows (namespace branches) inside the same `role="listbox"` viewport — `aria-required-children` is a hard ARIA contract violation, not a false positive.

**Correct primitive:** `role="grid"` + `role="row"` + `role="gridcell"`. Grids explicitly permit nested interactive widgets per WAI-ARIA APG, support multi-action rows natively, and have a different (richer) keyboard model that fits "rows with multiple actions" exactly. Switching to grid makes the axe suppressions unnecessary.

**Fix (paired with MAINT-128):** When each god-component is split, also re-evaluate the list role:

| Component | Recommended role | Suppressions removed |
|---|---|---|
| `PageBrowser` | `grid` (FEAT-14 mixed-mode is the strongest case) | 4 nested-interactive + 1 aria-required-children |
| `TrashView` | `grid` | 4 nested-interactive |
| `ConflictList` | `grid` | 2 nested-interactive |
| `HistoryListItem` (within `HistoryView`) | `grid` rows | 1 nested-interactive |
| `StaticBlock` (block rows in BlockTree) | reconsider — `<li>` + plain children may be enough; `role="button"` outer with nested buttons is the underlying smell | 7 nested-interactive |
| `TagFilterPanel` | likely `grid` | 2 nested-interactive |

**Independence from MAINT-128:** the role change is per-file and doesn't require the full god-component split. Either ship a per-component role flip ahead of MAINT-128, or fold both into the same PR per file.

**Cost:** M — each component is ~30 min to flip role + adjust keyboard handling + remove the axe override + verify with screen reader. ~6 components × 30 min = 3 h, plus testing.
**Risk:** Medium — keyboard handling and AT semantics need verification per component (manual NVDA / VoiceOver pass recommended).
**Impact:** M — closes ~21 axe-suppression sites AND fixes a real screen-reader-broken state for AT users.

## PERF — Performance items

### PERF-19 — Backlink pagination cursor uses linear scan for non-Created sorts (2 sites)

**Problem:** Two backlink pagination paths locate the cursor position with a linear scan when results are sorted by something other than block creation (e.g., due_date, priority, property value):
- `src-tauri/src/backlink/query.rs:112-128` — uses `.position(|s| s.as_str() == after_id)` on `sorted_ids`
- `src-tauri/src/backlink/grouped.rs:125-136` — uses `.skip_while(|(pid, _, _)| pid.as_str() != after_id)` on `group_list`

For `Created` sort, both already use binary search on lexicographic ULID order (correct, O(log n)). The linear-scan fallback is used because property sorts reorder by value, so binary search on ID is invalid — but the fallback is O(n) in the filtered result set.

**Why it matters:** N here is the already-filtered result set (per page), typically ≤50 items. At that size the linear scan is ~50 string comparisons — cheaper than building a HashMap would be. This is documented as a LOW-severity finding and would only matter if page size is ever raised well into the thousands. Listed here so it doesn't get reinvented as a "fix" later when someone sees the loop without context.

**Fix (if ever needed):** maintain a `HashMap<&str, usize>` during the sort step for O(1) cursor lookup. Only worth doing if page size grows past ~500.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if page size grows past ~500 or saved-query features ship.

**Cost:** S

### PERF-20 — Backlink filter resolver has no concurrency cap on `try_join_all`

**Problem:** `src-tauri/src/backlink/query.rs:80-82` fires every top-level filter concurrently via `try_join_all(filter_list.iter().map(|f| resolve_filter(pool, f, 0)))`. The read pool has 4 connections; if a user ever ends up with a filter expression holding 20+ OR-ed top-level filters, they all enqueue at once.

**Why it's LOW:** sqlx's `SqlitePool` queues gracefully when all connections are busy — it doesn't fail, it just waits. Realistic filter counts from the UI (`BacklinkFilterBuilder`) are 2–4. No known path to generate 20+ concurrent filters from normal usage. Flagging here in case a future "saved query library" or automation feature ever produces pathological inputs.

**Fix (optional, if saved-query features ship):**
```rust
let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
let futures = filter_list.iter().map(|f| {
    let sem = semaphore.clone();
    async move {
        let _permit = sem.acquire().await.ok()?;
        resolve_filter(pool, f, 0).await
    }
});
let results = try_join_all(futures).await?;
```

Or a simpler cap: reject filter lists longer than some reasonable limit (e.g., 16) at the command boundary.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if saved-query / automation features ship that can produce pathological filter counts.

**Cost:** S

### PERF-23 — `read_attachment_file` buffers whole file before chunked send

**Problem:** `src-tauri/src/sync_files.rs:182` (`read_attachment_file`) loads the full attachment into a `Vec<u8>` with `std::fs::read(path)` and hashes the complete buffer, then the caller at `src-tauri/src/sync_files.rs:294-300` iterates through `FILE_CHUNK_SIZE` (5 MB, defined at `sync_files.rs:34`) slices of that in-memory buffer for transmission. Peak memory per attachment is the file size (not N-additive — the loop is sequential).

**Why it's LOW:** For a personal notes app with typical attachments under 10 MB this is fine. Listed so that if the product ever intentionally targets large media (e.g., video notes), the correct fix is obvious.

**Fix (only if large attachments become a supported use case):** stream-hash and stream-chunk. Open a `tokio::fs::File`, wrap it in a `BufReader`, and in one pass:
- `blake3::Hasher::new()` → `update()` per buffer
- Collect chunk-size slices directly into the send queue without retaining the full buffer

This changes the signature of `read_attachment_file` (no longer returns `Vec<u8>` + hash together) and requires threading the streaming semantics through the sender loop. The chunk transport on the wire is already chunked, so no sync-protocol change is needed.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if large media (video notes, high-bit-depth images) becomes a supported use case.

**Cost:** S–M

---

### PUB-2 — Git author email across all history is corporate (`javier.folcini@avature.net`)

**Problem:** `git log --format='%ae %an' | sort -u` across all 1,400+ commits returns a single corporate email address. If the project is published under a personal identity (or the user later wants to avoid tying the repo to a specific employer), the history will still expose the corporate address on every commit, including to anyone who clones.

**Options:**
1. **Rewrite history with `git filter-repo`** using a mailmap to replace `javier.folcini@avature.net` with a personal email across all commits. This changes every commit SHA — must be done before any public push or before any collaborator clones.
2. **Add a `.mailmap`** that re-maps the author in views (`git log`/`git shortlog`) without rewriting history. Cosmetic only; the underlying commit objects still carry the corporate email.
3. **Leave as-is.** Accept the provenance signal. Defensible if the project is legitimately personal and the corporate email was simply the active git config at the time.

**If option 1 is chosen:**
- Take a full backup of `.git` before running `git filter-repo`.
- Script: `git filter-repo --mailmap mailmap.txt` with an entry like
  `Your Name <personal@example.com> <javier.folcini@avature.net>`.
- Re-verify signatures if any commits are GPG-signed.
- Do this before the first public push. Rewriting published history is disruptive.

**Cost:** S
**Decision:** Defer the identity/history choice until the publish target (PUB-5) and publish timing are concrete. No `.mailmap` added and no history rewrite performed in this session.
**Status:** DEFERRED — revisit alongside PUB-5 when a publish target and identity are locked in.

### PUB-3 — Employer IP clearance before public release

**Problem:** Most employment agreements in AR/US/EU include IP-assignment clauses that cover work done on company devices, on company time, or in the employer's line of business. The committed corporate email in the git history (see PUB-2) makes provenance visible to anyone who clones. Even for a side project unrelated to the employer's business, publishing substantial software without checking the employment contract carries legal risk that a coding agent cannot assess.

**Options:**
1. **Review the employment contract** (and any IP-assignment addenda signed during onboarding) for clauses covering personal projects. Common concerns: "on company time", "using company equipment", "related to the employer's business", "during the term of employment".
2. **Request written clearance** from the employer (in writing, e.g., email to HR/legal) before publishing. Keep the response filed.
3. **Consult a lawyer** if any clause is ambiguous, especially the "related to employer's business" language. Note-taking / productivity / developer tooling can be a grey area for some employers.
4. **Defer publishing** until clearance is obtained.

**Not an agent task.** No file should be modified based on this item. Agents must never publish, push to remote, or change repo visibility without the user explicitly stating "PUB-3 is cleared".

**Cost:** S (user's time; not an implementation task)
**Decision:** Defer — user-only legal task. Agent does nothing and does not revisit this item during routine sweeps. Will be marked cleared (and the item removed) only when the user explicitly states "PUB-3 is cleared".
**Status:** DEFERRED — user task, not agent-actionable.

### PUB-5 — Tauri updater endpoint URL pinned; keypair + secrets remain user-only

**Status:** the endpoint URL in `src-tauri/tauri.conf.json` now points at `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` (session 488). The remaining work is purely user-side and cannot be agent-actioned:

1. **Generate the Minisign keypair** (`cargo tauri signer generate -w ~/.tauri/agaric.key`). Back up the private key offline — losing it means future updaters can't verify against the deployed pubkey, breaking the auto-update chain for installed users.
2. **Paste the public key** into `tauri.conf.json` `updater.pubkey`.
3. **Add two GH Actions secrets** at `Settings → Secrets and variables → Actions`:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the generated `.key` file
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase used at generation time
4. **Uncomment** the two `TAURI_SIGNING_PRIVATE_KEY*` env lines in `release.yml:93-95` (under the `# PUB-5: Uncomment …` comment). The agent intentionally left these commented because uncommenting before the secrets exist + pubkey is set causes tauri-action to attempt signing with empty inputs.
5. **Tag a release** to verify: tauri-action will produce `*.sig` files alongside each bundle (`.dmg.sig`, `.AppImage.sig`, `.msi.sig`, etc.), which the in-app updater fetches and verifies against the embedded pubkey.

**Alternative (skip the updater):** remove the `updater` block from `tauri.conf.json` and the `tauri-plugin-updater` dependency from `src-tauri/Cargo.toml`. Users would update by manually downloading new releases.

**Cost:** S (~30 min of user work once the keypair is generated).

### PUB-8 — Android release keystore + 4 GH Actions secrets

**Problem:** `release.yml`'s `android-build-and-release` job already contains the full apksigner pipeline (zipalign + apksigner sign + apksigner verify + `gh release upload`), gated on a `ANDROID_KEYSTORE_BASE64` secret. Without the keystore + secrets the job uploads `agaric-<tag>-android-aarch64-unsigned.apk` (works on personal devices, but Play Protect warns and the APK can never be updated by a release-keystore-signed APK without uninstalling and losing data). The local `agaric-release.apk` previously in repo root was debug-keystore-signed and has the same dead-end property.

**Concrete remaining work:**
1. **Generate a release keystore** (one-time, locally):
   ```bash
   keytool -genkeypair -v \
     -keystore ~/agaric-release.jks \
     -alias agaric \
     -keyalg RSA -keysize 4096 -validity 10000 \
     -storetype PKCS12
   ```
   Pick stable CN/OU/O/L/ST/C — these are visible in Android Settings → Apps → Agaric → Advanced → "App signed by".
2. **Back up `agaric-release.jks` offline** (not in the repo, not in the GH secret, not in any cloud-synced folder you might lose). Lose this key and you lose the ability to ship updates that overwrite installed apps — Android refuses signature changes on upgrade. The base64 in the GH secret is *not* a backup; secrets are write-only after creation.
3. **Add 4 GH Actions secrets** at `Settings → Secrets and variables → Actions`:
   - `ANDROID_KEYSTORE_BASE64` ← `base64 -w0 ~/agaric-release.jks`
   - `ANDROID_KEYSTORE_PASSWORD` ← the store password from step 1
   - `ANDROID_KEY_ALIAS` ← `agaric` (or whatever alias you chose)
   - `ANDROID_KEY_PASSWORD` ← the key password from step 1
4. **Tag a release.** Next `git push --tags` produces `agaric-<tag>-android-aarch64.apk` (no `-unsigned` suffix) on the GitHub Release.

Full setup recipe in `BUILD.md` → "Release signing in CI" (under "Android Builds"). If you ever want to ship via Play Store later, this same key becomes the **upload key** under Play App Signing — Google holds the actual app signing key in that flow.

**Cost:** S (~15 min once you've decided what to use as DN).
**Status:** ACTIONABLE — pure operations, no design decision pending.

---

## UX — Frontend UX findings — Appended 2026-04-26

> Output of a two-pass review of all ~260 productive frontend files (components, hooks, libs, editor extensions, primitives, stores, workers, CSS).
>
> Pass 1: 6 parallel domain reviewers produced ~135 candidate findings. Pass 2: 6 parallel verification subagents re-read the source and refuted / downgraded / merged candidates. ~50 were false positives and dropped — most notably the entire `prefers-reduced-motion` cluster against `ui/dialog.tsx` / `ui/sheet.tsx` / `ui/popover.tsx` / `ui/select.tsx` / `ui/alert-dialog.tsx` / `ui/tooltip.tsx` (the global rule at `src/index.css:1209-1226` already zeroes animation and transition durations for every element — the six "high severity" findings were redundant). Sonner's internal `aria-live="polite"`, `ConfirmDialog`'s intentional dual-`autoFocus` per UX-259, `GutterButton`'s tooltip + aria-label, `ui/close-button.tsx`'s 44 px coarse-pointer sizing, every "missing focus-visible" claim on components that use the `Button` primitive, `ConflictList`'s already-rendered `batchProgress`, and `SettingsView`'s live font-size preview were all refuted on source.
>
> The remaining UX-* items below bundle the confirmed findings; grouped where the fix is one batch of mechanically similar edits, kept separate where the risk profile or user-visible behaviour differs. Each item lists every concrete site so the batch can be fixed in one pass without re-discovery.
>
> Scope note: UX perception (discoverability, affordance, feedback, a11y, touch, keyboard, consistency with the design system). Architectural / behavioural defects in the frontend are filed as FEAT-* / MAINT-* elsewhere. Aspirational rewrites, speculative claims without code evidence, and findings forbidden by AGENTS.md "Architectural Stability" were dropped in pass 2.

### UX-10 — Projected entries in DuePanel are visually indistinguishable from real tasks

**What:** `src/components/DuePanel.tsx:344-397` renders "projected" entries (future occurrences computed from repeat rules) with only a `border-dashed border-muted-foreground/20 bg-muted/30 text-muted-foreground` treatment. There is no per-entry "Projected" badge or icon, so users misread them as real tasks due today. Separately, the content is rendered with `truncate` at `:376-388` with no `title=` / Tooltip, so long names are cut off with no way to preview the full content.

**Fix:** Per projected entry, render a small badge or icon next to the content: `<Badge variant="outline" className="text-xs font-normal"><Repeat className="h-3 w-3 mr-1" /> {t('duePanel.projectedBadge')}</Badge>`. Add `title={entry.block.content ?? ''}` on the truncated `<span>` (or wrap it in `<Tooltip>` if a richer preview is wanted). Consider making the section header "Projected" (line ~346) larger / semibold so the category boundary is visible.

**Cost:** S (<1h).
**Risk:** Low.
**Impact:** L — the dashed border does communicate *something*; adding an explicit label just makes it unambiguous.

### UX-11 — Focus management edge cases

**What:** Four subtle focus bugs:

- `src/components/BlockContextMenu.tsx:135-138` — `handleCloseWithFocus` does `triggerRef?.current?.focus()` with no fallback. If the trigger block was deleted during the menu's lifecycle, `focus()` is called on `null` and focus silently lands on `<body>`. Add a sensible fallback target (the parent block, the block-tree container).
- `src/components/BlockContextMenu.tsx:170-200` — the menu is positioned via `computePosition` after mount, starting at an off-screen `{ x: -9999, y: -9999 }`. On slow devices the `animate-in fade-in-0 zoom-in-95` animation can begin *before* the first position tick resolves, producing a brief visual zoom-in from off-screen. Defer animation by one frame, or start with `opacity-0` until positioning completes.
- `src/editor/use-block-keyboard.ts:18-23,210-229` — `isSuggestionPopupVisible()` suppresses arrow-key block navigation whenever a `.suggestion-popup` exists in the DOM. It checks `checkVisibility()` / `offsetParent !== null` but not `isConnected`. If a suggestion teardown leaks a detached node, the arrow keys are swallowed and the user feels like navigation is stuck. Add `if (!popup.isConnected) return false` before the visibility check.
- `src/components/PageBrowser.tsx:749-789` — the outer row div paints a ring when `focusedIndex === pageIndex` **and** the inner button also paints its own `focus-visible` ring, producing a confusing double-ring / ambiguous-focus appearance when the row has keyboard focus. Pick one owner for the ring (prefer removing the outer ring and relying on the button's `focus-visible`).

**Fix:** BlockContextMenu close: `triggerRef?.current?.focus() ?? document.querySelector<HTMLElement>('[data-block-id="' + blockId + '"] [role="button"]')?.focus() ?? null`. BlockContextMenu position: set the menu to `opacity-0` in initial render, flip to `opacity-100` after `computePosition`. `use-block-keyboard`: add `isConnected` guard. PageBrowser: drop the outer `ring-2 ring-inset ring-ring/50 bg-accent/30` conditional and keep the inner button's `focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50`.

**Cost:** S (<1h each).
**Risk:** Low.
**Impact:** L–M — each is a "sometimes feels weird" bug rather than a hard failure, but they together degrade the sense that focus is never lost.

### UX-12 — Low-severity polish batch

**What:** Individually small, collectively worth a sweep:

- `src/components/PropertyRowEditor.tsx:355-367` — ref-picker: while one row is saving, **all** buttons get `disabled={savingRefPageId !== null}` but only the saving row gets `aria-busy={saving}`. Change to `disabled={saving}` per row (or add `aria-busy={saving}` at the list container).
- `src/components/PropertyRowEditor.tsx:431-439` — pencil (edit-options) Button has no `aria-label`; the correctly-labelled twin a few lines below shows the pattern.
- `src/components/LinkEditPopover.tsx:185-204` — URL error shows red text but the Input itself doesn't gain `border-destructive`. Add `className={cn('h-8 [@media(pointer:coarse)]:h-11 text-sm', urlError && 'border-destructive')}`.
- `src/components/BlockInlineControls.tsx:260-280` — due-date chip uses dynamic colour (`dueDateColor(dueDate)`) but the scheduled-date chip is static (`bg-date-scheduled`). Either both dynamic or document why scheduled doesn't care about past / today / future.
- `src/components/BlockContextMenu.tsx:414-418` — "No actions available" renders as plain text. Prefer not opening the menu at all when `visibleItems.length === 0`.
- `src/components/FeatureErrorBoundary.tsx:56-89` — dumps raw `error.message`; add "Your data is safe — Retry reloads this panel" copy so users don't panic.
- `src/components/BugReportDialog.tsx:385-396` — required checkbox has no visual required marker (asterisk / "(required)") even though the submit button is gated on it.
- `src/components/PairingQrDisplay.tsx:59-74` — passphrase has no copy button; the "Paused while typing…" indicator is a muted italic span that's easy to miss.
- `src/components/PeerListItem.tsx:94-138` — address-edit popover has no close / Cancel button (outside-click dismiss is the only path).
- `src/components/PeerListItem.tsx:49-62,120-130` — "Address invalid" toast has no format hint, and the inline help text is `text-[10px]`. Bump to `text-xs` and include the expected format (e.g., `192.168.1.100:5000`).
- `src/components/DataSettingsTab.tsx:134-146` — multi-file import progress is text-only; a `<progress value={currentFileIndex} max={totalFiles} className="w-full h-1 mt-2" />` is two lines of code.
- `src/components/journal/JournalCalendarDropdown.tsx:213-234` — legend dots are 8 px (`h-2 w-2`). Bump to `h-3 w-3`.
- `src/components/AgendaResults.tsx:315-343` — group headers are `text-xs text-muted-foreground`; bump to `text-sm font-semibold` to match other panel headers in the app.
- `src/components/AgendaFilterBuilder.tsx:295-350` — filter pills have no `title=` on the button, so long property values truncate without a way to reveal the full value.
- `src/hooks/useDateInput.ts:72-98` — 300 ms NL-parse debounce with no "parsing…" hint; users think typing went nowhere. Add a small transient indicator when `now - lastTypedAt < 300ms`.
- `src/components/TemplatesView.tsx:235-238` — "No search results" message doesn't show total count; add `(${templates.length} templates total)` to give context.
- `src/components/BugReportDialog.tsx:468-478` — log preview truncates at 500 chars with a "Showing N of M" message but no "View full" affordance. A toggle `Button variant="link" size="sm"` is adequate.
- `src/components/ConflictListItem.tsx:126-144` — conflict-type badge has a `<Tooltip>` but no visual affordance (`cursor-help` / dashed border) to indicate interactivity.

**Fix:** One polish sweep — each item is 1–5 lines of change. Schedule as a single "UX polish" PR so the diff is reviewable but the ticket count stays manageable.

**Cost:** M (3–6h for the full sweep).
**Risk:** Low — no behaviour changes, all additive.
**Impact:** L individually; M collectively (this is the kind of change a user notices as "the app feels more polished" without pointing at any single item).

---

## Backend Code Review (Confirmed Findings) — Appended 2026-04-25

> Output of a deep, two-pass parallel backend code review covering all of
> `src-tauri/src/` (~128k LOC, 192 files). Pass 1: 10 domain reviewers.
> Pass 2: 10 independent validators that cross-checked every finding
> against the actual code. Hallucinations / out-of-scope claims dropped.
> Severities reflect Pass-2 corrections.
>
> All entries below are CONFIRMED issues. Already-tracked items
> (PERF-19, PERF-20, PERF-23) are referenced but not duplicated.
>
> Source artifacts: `/tmp/agaric-review/pass1/` (raw findings),
> `/tmp/agaric-review/pass2/` (validator verdicts),
> `/tmp/agaric-review/FINAL-CONSOLIDATED.md` (full report).

**Scope:** All Rust backend code in `src-tauri/src/` (~128k LOC, 192 files, 35 migrations).
**Method:** 10 parallel domain reviewers (Pass 1) + 10 independent validators (Pass 2) cross-checking every finding against the actual code, with hallucinations / out-of-scope claims dropped and over-stated severities corrected.

> Threat model reminder (AGENTS.md): Agaric is a single-user, multi-device, local-network-only app. Findings recommending hardening against adversarial sync peers were rejected as out-of-scope. Findings about data integrity, accidental corruption, and robustness against the user's own buggy peer software ARE in scope.

---

## Executive Summary

| Metric | Count |
|---|---|
| Raw Pass 1 findings | 348 |
| Dropped (hallucinated / out-of-scope / duplicate / wontfix-intentional) | 12 |
| Severity-downgraded by Pass 2 | 49 |
| Already-tracked in REVIEW-LATER (PERF-19, PERF-20, PERF-23) | 3 |
| Net findings in this report | 333 |
| **Critical** | **1** |
| **High** | **4** |
| **Medium** | **28** |
| **Low** | **124** |
| **Info / nits** | **125** |

### Top-priority items (Impact ÷ Cost)

1. **C-2b** — Boot-time op-log replay path for unmaterialized ops; op_log diverges from materialized state with no automatic remediation (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/materializer/consumer.rs" />). C-2a (divergence detection) shipped — divergence is now visible via `fg_apply_dropped` in `StatusInfo`; C-2b remains as the actual replay path. **Schema migration approval required**.
2. **H-17** — `recurrence::handle_recurrence` reads counters BEFORE `BEGIN IMMEDIATE` (TOCTOU); two clicks on a recurring task can duplicate or skip the next-occurrence sibling (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/recurrence/handle.rs" />).

### Findings by Domain × Severity

| Domain | Crit | High | Med | Low | Info |
|---|---|---|---|---|---|
| Core data layer | 0 | 1 | 4 | 9 | 11 |
| Materializer | 1 | 2 | 5 | 8 | 4 |
| Cache + Pagination | 0 | 0 | 6 | 12 | 6 |
| Commands (CRUD) | 0 | 1 | 6 | 9 | 13 |
| Commands (System) | 0 | 2 | 10 | 13 | 6 |
| Sync stack | 0 | 3 | 10 | 25 | 5 |
| Search & Links | 0 | 2 | 4 | 16 | 19 |
| Lifecycle / Snapshots | 0 | 0 | 17 | 16 | 8 |
| MCP | 0 | 0 | 6 | 12 | 8 |
| GCal / Spaces / Drafts | 0 | 0 | 9 | 11 | 9 |

(Numbers approximate; some findings span domains and are listed under the primary one.)

### Already tracked (NOT re-reported)

- **PERF-19** — Backlink pagination cursor uses linear scan for non-Created sorts. Confirmed still applicable.
- **PERF-20** — Backlink filter resolver `try_join_all` has no concurrency cap. Pass 2 confirmed **3 sites, not 2** as REVIEW-LATER.md claims — recommend updating that entry.
- **PERF-23** — `read_attachment_file` buffers whole file before chunked send. Confirmed unchanged.

### Patterns / Themes (cross-cutting systemic issues)

1. **CQRS write path bypassed in several places.** `set_page_aliases_inner` (commands/pages.rs), `page_aliases` mutation, `update_last_address` (peer_refs.rs), and a handful of cache rebuilds write derived state without an op-log append. These create silent divergence between op_log and materialized tables.
2. **Atomicity gaps in multi-op user actions.** `set_todo_state` + recurrence sibling, `set_page_aliases`, `flush_draft` + `prev_edit` read, `disconnect_gcal` (3 writes), `create_snapshot` (INSERT pending then UPDATE complete), `restore_page_to_op` (read outside write tx) — none use a single `BEGIN IMMEDIATE` even though all are "either both happen or neither" scenarios.
3. **Backpressure silent-drops are wider than documented.** `try_enqueue_background` Full-arm doesn't increment `bg_dropped`; `apply_snapshot` cache-rebuild fan-outs use the same path; `enqueue_full_cache_rebuild` partial-success is invisible. Pass 2 downgraded the severity to Medium but the systemic pattern stands.
4. **Recursive CTE invariants (is_conflict = 0 + depth < 100) are inconsistent.** Production paths in `tag_inheritance` and `pagination::children` are correct; `move_block_inner` cycle CTE, `cascade_soft_delete`, the `tag_query` and `backlink::resolve_root_pages` CTE oracles, and `reindex_block_links` all miss one or both predicates.
5. **Split-pool invariant violated in 5+ places.** `*_split` cache variants (tags, pages, projected_agenda, page_ids), `materializer::sweep_once`, `fetch_link_metadata` (uses WritePool for read-heavy work), and a handful of background tasks ignore the read pool entirely.
6. **Doc / code drift across AGENTS.md, ARCHITECTURE.md, and REVIEW-LATER.md.** AppError variants (11 vs 12 with Gcal); `find_lca` 10000-iter cap claim has no implementation; FTS tokenizer doc says unicode61 but code uses trigram; ARCHITECTURE.md §15 says DB/IO/JSON errors are sanitized but 5 command files skip the helper; REVIEW-LATER PERF-20 site count wrong; ARCHITECTURE.md doesn't mention MCP at all.
7. **Sync hash chain identity is non-cryptographic.** Per `compute_op_hash`, the digest covers `device_id|seq|parent_seqs|op_type|payload` but **not** `prev_hash`. Pass 2 downgraded "data integrity" framing — within the single-user threat model the chain is a deterministic fingerprint, not a Merkle commitment. Filed as a documentation gap.
8. **OAuth & filesystem secret hygiene is good but not perfect.** SecretString redaction tested, keychain-only storage; minor leakage paths exist via classify_refresh_error formatting upstream Display, JWT id_token signature unverified, and partial token leakage on serde error. Bug-report redaction allow-list only catches `$HOME` + local `device_id` — leaks GCal email, peer device IDs.

### Quick wins (Cost = S, Impact ≥ Medium, Risk ≤ Medium)

| ID | Title | Why |
|---|---|---|
| **H-17** | `recurrence::handle_recurrence` reads counters before BEGIN IMMEDIATE (TOCTOU) | Two clicks duplicate next-occurrence sibling |
| **M-23** | `flush_draft_inner` reads `prev_edit` outside the flush transaction | Conflict-detection asymmetry vs `edit_block_inner` |

---

## CRITICAL findings (1)

### C-2b — Boot-time op-log replay path for unmaterialized ops
- **Domain:** Materializer / Recovery
- **Location:** `src-tauri/src/recovery/boot.rs:43-126`; `src-tauri/src/materializer/coordinator.rs`
- **What:** On boot, identify ops whose materialized state is missing or stale (e.g., compare `op_log` max-seq vs each derived table's high-water mark) and re-enqueue them through the materializer foreground queue. Idempotent: every existing op handler is already idempotent or trivially convertible (the materializer ALREADY uses `INSERT OR IGNORE` / UPSERT on the convergence path).
- **Why it matters:** This is the actual fix for the C-2 family of findings: foreground `ApplyOp` / `BatchApplyOps` failures only bump `fg_errors` + `fg_apply_dropped` and the task is dropped after a single 100ms in-memory retry — there is no persistent retry queue (`RetryKind::from_task` excludes both task types) and no boot-time op-log replay path (`recover_at_boot` only handles drafts and pending snapshots). With C-2b in place, op log truly is the source of truth: even after a crash mid-apply or a transient FK contention drop, the next boot reconciles automatically. C-2a (divergence detection — `fg_apply_dropped` metric + warn line) shipped, so the divergence rate is now observable in `StatusInfo`.
- **Cost:** M–L
- **Risk:** Medium (idempotency must be verified end-to-end across every op handler; replay needs progress markers so a partial replay survives a second crash)
- **Impact:** High (closes the last automatic-divergence gap in CQRS)
- **Recommendation:** Build on the existing `recover_at_boot` infrastructure. Each derived table tracks a "materialized through seq N" cursor; the replay walks `op_log WHERE seq > cursor`. Add an integration test that injects ApplyOp failure mid-batch, restarts the pool, and asserts state convergence post-replay. **Schema migration required** (per-table cursor tracking) — needs explicit user approval before implementing per AGENTS.md "Architectural Stability".
- **Status:** Open. No dependencies (C-2a shipped). Schema migration approval required.

---

## HIGH findings (3)

### H-9 — Bug-report redaction allow-list misses GCal email, peer device IDs, and any other PII (parent — split into H-9b, H-9c after H-9a shipped)
- **Domain:** Commands / System
- **Location:** `src-tauri/src/commands/bug_report.rs`
- **What:** Redaction now scrubs `$HOME` + local `device_id` + GCal email + peer device IDs + a generic email regex (H-9a shipped). The remaining work is the architectural shift to a deny-list (H-9b) and the user-facing preview UI (H-9c).
- **Why it matters:** H-9a closed the immediate user-visible leak vectors. H-9b makes the redaction posture future-proof; H-9c adds defense-in-depth UI.
- **Cost:** L (combined) — split into H-9b (M, generic redaction architecture), H-9c (M, preview UI). Both can be scheduled separately.
- **Pass-1 source:** 05-commands-system / F5

### H-9b — Bug-report: replace allow-list with deny-list-of-tokens architecture
- **Domain:** Commands / System
- **Location:** `src-tauri/src/commands/bug_report.rs`
- **What:** Refactor the redact pipeline from "scrub these specific values" to "include only these specific token classes" (e.g. ULIDs, op_log seqs, error type names, file:line refs, well-known tracing field keys). Anything outside the safe-token set is replaced with `[REDACTED]`. Conservative-by-default: a property value that doesn't fit a known type gets redacted.
- **Why it matters:** Makes the redaction posture future-proof — every new field added to a log line is redacted by default rather than leaked by default.
- **Cost:** M
- **Risk:** Medium (false positives can make logs hard to read; need careful tuning of the safe-token set)
- **Impact:** High
- **Recommendation:** Build on top of H-9a. Use the existing `tracing` JSON output as the input format; the safe-token set lives in a single constant array in `bug_report.rs`. Add a property test that no value outside the safe set survives the pipeline.
- **Status:** Open. Should land after H-9a (which covers the immediate regression).

### H-9c — Bug-report: "are you sure" UI showing the redacted preview before submit
- **Domain:** Frontend / Commands
- **Location:** `src/components/BugReportDialog.tsx`; `src-tauri/src/commands/bug_report.rs` (preview command)
- **What:** Before the report ZIP is finalized for upload (or download to disk), show the user the redacted contents in a scrollable diff-style preview with a "Submit" button gated on the user's confirmation. Also expose a checkbox "I have reviewed the redacted output" required to enable Submit.
- **Why it matters:** Defense-in-depth. Even with H-9a + H-9b, the user is the last line of defense for "did this leak my company email, my client name, my password I accidentally typed into a note?". The preview surfaces what's actually being sent.
- **Cost:** M
- **Risk:** Low (additive UI, no data path change)
- **Impact:** High (user trust in the bug-report feature)
- **Recommendation:** Tauri command `bug_report_preview()` returns the same redacted bundle as the existing submit, but does not upload. The dialog renders it via the existing `ScrollArea` + diff viewer primitives. Cross-references UX-277 (`BugReportDialog` polish — adding "no log-content preview before submit" was already filed there at S cost; this finding promotes it to H-9c with a richer scope).
- **Status:** Open. Independent of H-9a / H-9b. May supersede the "no log-content preview" item in UX-277 — when H-9c lands, drop the preview bullet from UX-277.

## MEDIUM findings (37 — expanded)

> Each entry is now a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status) ready to be picked up.

### Core data layer



### M-3 — AGENTS.md says `AppError` has 11 variants; code has 12 (`Gcal`)
- **Domain:** Core
- **Location:** `AGENTS.md:174` vs `src-tauri/src/error.rs:91-131`
- **What:** AGENTS.md states `AppError` has 11 variants and lists them by name, but the implementation also defines `AppError::Gcal(#[from] GcalErrorKind)` at `error.rs:129-130`. The `Serialize` impl at `error.rs:142-155` correctly emits the `"gcal"` `kind` string, which is also missing from the AGENTS.md description.
- **Why it matters:** AGENTS.md is the norms-of-record for review agents and contributors; an off-by-one that omits a real variant teaches every future reviewer the wrong invariant and obscures a documented frontend `kind` discriminator.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Update AGENTS.md:174 to say "12 variants" and append `Gcal`. While there, list the `kind` strings (`"database" | "migration" | … | "gcal"`) since the doc claims the frontend matches on `kind`. **Requires explicit user approval per AGENTS.md self-rule (no AGENTS.md edits without approval).**
- **Pass-1 source:** 01/F4
- **Status:** Open

### M-6 — `cleanup_orphaned_attachments` is a no-op TODO that ships in production
- **Domain:** Core
- **Location:** `src-tauri/src/materializer/handlers.rs:520-524` (handler), `:571` (dispatch wiring)
- **What:** The handler returns `Ok(())` after a single `tracing::debug!` and an explicit `let _ = pool;`. The `MaterializeTask::CleanupOrphanedAttachments` variant is wired through dispatch and tested as if it works. With `delete_block`/purge already operational and attachment file transfer running through the sync daemon, attachment files in the on-disk store are never reclaimed.
- **Why it matters:** On a long-lived install, deleted/purged blocks free DB rows but the underlying attachment files accumulate indefinitely, silently filling the user's disk. There is no GC path elsewhere for orphaned attachment files.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Implement the handler against the existing `attachments` table: enumerate the attachments root directory, `SELECT id, fs_path FROM attachments WHERE deleted_at IS NULL`, and unlink files with no live DB row. At minimum, escalate the placeholder log from `debug!` to `warn!` so the deferred-work signal is visible. Implementation stays within existing schema + task type.
- **Pass-1 source:** 02/F12
- **Status:** Open

### Materializer


### M-12 — In-flight tokio tasks not cancelled at shutdown
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/coordinator.rs:319-327`, `src-tauri/src/materializer/coordinator.rs:525-537`
- **What:** `Materializer::shutdown` flips `shutdown_flag` and drops the channel senders, breaking the consumer `recv` loops on next iteration. But `Self::spawn_task` (used for the metrics-snapshot task, the block-count refresh, and per-task spawned futures) returns no `JoinHandle`. Long-running per-task futures inside `process_single_foreground_task` / `run_background` (e.g. an FTS rebuild taking many seconds) keep running with no `select!` against the shutdown flag and no `JoinHandle::abort()`.
- **Why it matters:** During a sequenced shutdown (sync stop → materializer flush → DB close), the writer pool can be torn down while a background rebuild is still mid-transaction, producing a writer-pool error in the logs and a slow / hung app exit. The risk surfaces on app-close after heavy editing.
- **Cost:** M (2-8h)
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Track a `tokio::task::JoinSet` (or hold the `JoinHandle`s) on the `Materializer` struct, and in `shutdown()` call `abort_all()` after a short grace period; alternatively pass a `tokio::sync::Notify` shutdown signal into the long-running handlers and `select!` against it. The retry-queue sweeper (`retry_queue.rs:261`) already has the same fire-and-forget pattern and would benefit from the same treatment.
- **Pass-1 source:** 02/F9
- **Status:** Open

### Cache + Pagination

### M-16 — `trash_descendant_counts` joins on `deleted_at` only — over-counts when batches collide
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/trash.rs:120-134` (REVIEW-LATER.md mis-cites this as `cache/trash.rs`; the file is `pagination/trash.rs`).
- **What:** The descendant-count query joins `blocks d` to `blocks rb` purely on `d.deleted_at = rb.deleted_at AND d.is_conflict = 0`, with no ancestry constraint. Two unrelated roots that happen to be soft-deleted at the same `deleted_at` (timestamp collisions are possible — `cascade_soft_delete` writes `now_rfc3339()`, tests use `FIXED_DELETED_AT = "2025-01-15T00:00:00+00:00"`, and bulk operations can share a millisecond) each see the other batch's blocks counted as their descendants. The doc-comment promises ancestry but the SQL does not enforce it.
- **Why it matters:** The Trash UI's "+N more" badge under each root shows inflated counts whenever timestamps collide. None of the current tests exercise two unrelated roots with the same `deleted_at`.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Restrict the `d`/`rb` join to actual descendants — either a recursive CTE rooted at each `rb.id` (filter `is_conflict = 0`, bound `depth < 100` per invariant #9), or an ancestry subquery using `parent_id`. Add a test creating two unrelated trees soft-deleted at the same `deleted_at` and asserting each reports only its own descendants.
- **Pass-1 source:** 03/F4
- **Status:** Open

### M-17 — Four `*_split` cache rebuilds ignore the `read_pool` and run reads on the writer
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/tags.rs:95-99`, `src-tauri/src/cache/pages.rs:66-71`, `src-tauri/src/cache/projected_agenda.rs:244-249`, `src-tauri/src/cache/page_id.rs:64-68`
- **What:** Per AGENTS.md invariant #7, background rebuilds should read from the reader pool and only acquire a writer for the final INSERT/DELETE transaction. Four of the eight `*_split` variants accept a `_read_pool: &SqlitePool` parameter, ignore it, and delegate to the single-pool implementation against `write_pool`. The doc-comments justify it as "background, stale-OK", but `rebuild_projected_agenda_cache` in particular performs substantial Rust-side computation (up to 365 projections per repeating block) while holding a writer — the exact scenario the split-pool pattern was introduced to avoid.
- **Why it matters:** Hot-path writes (op apply) wait on writer-pool capacity; cache rebuilds that hold writers longer than necessary increase tail latency. The `_unused` parameter also makes it harder for future maintainers to reason about which rebuilds follow the documented pattern.
- **Cost:** M (projected_agenda + page_ids); S (tags + pages, where the work is one `INSERT … SELECT`)
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** For `projected_agenda` and `page_ids`, materialize the input on `read_pool` (page_ids: read all `(id, parent_id, block_type, is_conflict)` rows then UPDATE on writer; projected_agenda: read repeating-block + property rows on reader, compute, then chunked INSERT on writer). For tags/pages, either pre-fetch on the reader and chunked-INSERT on the writer, or rename them `*_no_split` to make the contract explicit. Update the AGENTS.md "Split read/write pool pattern" note to enumerate the exempt rebuilds.
- **Pass-1 source:** 03/F5
- **Status:** Open

### M-18 — Per-row INSERT/UPDATE/DELETE loops in agenda diff and projected-agenda rebuild
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/agenda.rs:160-186` (single-pool) and `:342-368` (split); `src-tauri/src/cache/projected_agenda.rs:223-232`
- **What:** Both incremental agenda rebuilds and the projected-agenda rebuild apply changes one row at a time inside the transaction — separate prepared statements per delete, per update, and per insert in agenda diff; per-entry `INSERT OR IGNORE … VALUES (?,?,?)` after a single `DELETE FROM projected_agenda_cache` for projected agenda. This violates Backend Pattern #6 (multi-row chunked INSERT bounded by `MAX_SQL_PARAMS`); `cache/block_tag_refs.rs:258-272` already implements the chunked pattern correctly in the same module.
- **Why it matters:** For a 365-day projection × thousands of repeating blocks, the projected-agenda rebuild is dominated by per-row round-trips; same for large agenda diffs after bulk imports. With ~10K rows the difference is roughly 10K vs. ~20 round-trips inside the transaction.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Adopt the `MAX_SQL_PARAMS / N`-chunked multi-row INSERT pattern from `cache/block_tag_refs.rs` for `projected_agenda` (3 columns → chunk 333) and the agenda-diff inserts. For agenda-diff deletes, replace the per-row loop with a single `DELETE FROM agenda_cache WHERE (date, block_id) IN (SELECT value->>'$[0]', value->>'$[1]' FROM json_each(?))` driven by the `to_delete` set.
- **Pass-1 source:** 03/F6
- **Status:** Open

### M-19 — Unbounded `Vec` materialization on full-vault scans
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/agenda.rs:58-112` (`desired_rows`); `src-tauri/src/cache/block_tag_refs.rs:233-238` (`source_rows`); `src-tauri/src/cache/projected_agenda.rs:90,214` (`entries: Vec`)
- **What:** `rebuild_block_tag_refs_cache_impl` reads `(id, content)` for every non-deleted, non-conflict block into a `Vec<>` and runs the regex across the full content per row. The agenda rebuild materializes both desired-state UNION-ALL rows and the entire current cache into two `HashMap`s. The projected-agenda rebuild buffers a `Vec<(String, String, String)>` of every projection (up to 365 days × every repeating block) before flushing. With ~100K blocks averaging ~1KB content, that is ~100MB on the Rust heap plus `cap[1].to_string()` duplicates.
- **Why it matters:** On larger vaults (or Android, where the footprint is tighter) full-vault rebuilds risk OOMs during snapshot import. Today no streaming alternative exists.
- **Cost:** L
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Stream rows for `block_tag_refs` rebuild via `fetch(...)` and run the regex per row, accumulating only `(source_id, tag_id)` tuples. For agenda rebuild, compute the diff by streaming both sides in `(date, block_id)` sorted order and merging — eliminates the two `HashMap` allocations. For projected-agenda, chunk-flush every ~10K projections into the writer instead of accumulating the entire vault first.
- **Pass-1 source:** 03/F7
- **Status:** Open

### Commands (CRUD)

### M-25 — `list_projected_agenda_inner` returns hard-capped `Vec<>` without cursor pagination
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/agenda.rs:111-214`, Tauri wrapper at `src-tauri/src/commands/agenda.rs:467-476`
- **What:** The command (and its wrapper) returns a flat `Vec<ProjectedAgendaEntry>` clamped to `[1, 500]` with no `next_cursor`. AGENTS.md invariant #3 requires cursor-based pagination on every list query, and ARCHITECTURE.md §22 already lists this query as superlinear at 100K agenda entries — at scale the hard cap silently drops items.
- **Why it matters:** Frontend has no signal that more entries exist beyond the cap, so projected agendas truncate without warning. The cap is a workaround, not a contract.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Change the return type to `PageResponse<ProjectedAgendaEntry>` keyed on `(projected_date, block_id)` from `projected_agenda_cache`, and keep the current cap only as a degenerate first-run behaviour for the on-the-fly fallback.
- **Pass-1 source:** 04/F9
- **Status:** Open

### M-26 — `delete_property_def_inner` orphans `block_properties` rows for the deleted key
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/properties.rs:520-537`
- **What:** Deleting a property definition leaves every `block_properties` row whose `key` matches in place. Since `def_meta` is then `None` in `set_property_in_tx` (`crud.rs:1144-1149`), subsequent writes silently skip the type/options validation block — i.e. deleting a definition relaxes validation on every prior row using that key.
- **Why it matters:** Properties are the documented primary extension point (AGENTS.md "Architectural Stability"); the doc-comment promises "Returns error if the key doesn't exist" but the code "deletes the registry row and orphans the data". Recreating the same key with a different `value_type` later mismatches existing data.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Inside a single tx, `SELECT EXISTS(...)` for `block_properties` rows on this key and reject the delete unless the caller passes a `force` flag (or cascade-clears those rows). Add tests for both directions.
- **Pass-1 source:** 04/F12
- **Status:** Open

### M-27 — `export_page_markdown_inner` full-table-scans every tag and page on each export
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/pages.rs:181-200` (resolver), context `pages.rs:161-340`
- **What:** To resolve `#[ULID]` and `[[ULID]]` tokens, the function loads `(id, content)` for every non-deleted `tag` and `page` block in the vault, builds two `HashMap`s, then exports only direct children (`list_children` with `limit=1000`, no pagination — descendants beyond the cap are silently truncated).
- **Why it matters:** AGENTS.md "Backend Patterns" #3 says batch by `json_each`, not full scans; with the documented 100K-block target this loads tens of thousands of rows per export. The undocumented direct-children-only truncation is a separate correctness issue.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** (1) Cursor-paginate `list_children` until exhausted into a buffer; (2) regex-extract ULIDs from the buffer; (3) issue one `SELECT id, content FROM blocks WHERE id IN (SELECT value FROM json_each(?))` for the union of tag+page references; (4) decide and document whether the export covers descendants and flag the truncation if it does not.
- **Pass-1 source:** 04/F14
- **Status:** Open

### Commands (System)

### M-28 — `attachments.deleted_at` is dead code; soft-delete schema vs hard-delete handler
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/attachments.rs:189-204` (read filter), `src-tauri/src/commands/attachments.rs:138-179` (hard delete), `src-tauri/migrations/0001_initial.sql:43-52` (schema)
- **What:** `attachments.deleted_at` is declared in migration 0001 and `list_attachments_inner` filters with `WHERE block_id = ? AND deleted_at IS NULL`, but neither `delete_attachment_inner` (line 168) nor the materializer's `DeleteAttachment` handler (`materializer/handlers.rs:510`) ever writes to `deleted_at` — both issue `DELETE FROM attachments`. The filter therefore evaluates to `TRUE` for every surviving row.
- **Why it matters:** New readers reasonably assume soft-delete semantics and may write code that depends on it; the column is also why `list_attachments` cannot be a simple compile-time-checked `query_as!` against the canonical schema fields.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) drop the `deleted_at` column in a new migration and remove the filter, or (b) flip `delete_attachment` to soft-delete (`UPDATE attachments SET deleted_at = ?`) — option (b) requires a new op-type or payload extension and per AGENTS.md "Architectural Stability" needs explicit user approval.
- **Pass-1 source:** 05/F2
- **Status:** Open

### M-30 — No uniqueness on `attachments.fs_path`; duplicate adds collide silently
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/attachments.rs:99-111`, `src-tauri/migrations/0001_initial.sql:43-52`
- **What:** Two `add_attachment` calls with the same `fs_path` (different `attachment_id`, even different `block_id`) succeed and produce two rows pointing at the same file. Once F1 (`delete_attachment` actually unlinks the file) lands, deleting one row would clobber the other's content.
- **Why it matters:** Pre-condition for any future "actually unlink the file on delete" fix to be correct. The frontend's ULID-in-path convention makes collisions unlikely in normal flow, but no schema guard enforces it.
- **Cost:** S
- **Risk:** Medium — if two devices independently chose identical fs_paths during sync import, a `UNIQUE` migration could fail on existing user DBs; needs a data-shape audit. Per AGENTS.md "Architectural Stability" the migration itself needs user approval.
- **Impact:** Low
- **Recommendation:** Add `CREATE UNIQUE INDEX idx_attachments_fs_path ON attachments(fs_path)` in a new migration, and add a `tests/data_shape` assertion that all existing rows are unique; if collisions show up in real DBs, namespace fs_path under `attachment_id` during import.
- **Pass-1 source:** 05/F4
- **Status:** Open


### M-34 — `start_pairing_inner` builds a QR with `host=0.0.0.0, port=0`
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:91-109` (function), `src-tauri/src/commands/sync_cmds.rs:97` (QR payload), `src-tauri/src/commands/sync_cmds.rs:107` (`port: 0`)
- **What:** The QR payload is `pairing_qr_payload(&passphrase, "0.0.0.0", 0)` and the returned `PairingInfo.port` is also `0`. ARCHITECTURE.md §18:1446 says the QR JSON is `{"passphrase":"...","host":"...","port":12345}`; the scanning device cannot use the QR to bootstrap a direct connection and must fall back to mDNS for both discovery and address resolution.
- **Why it matters:** Either the QR-as-bootstrap design has been abandoned (in which case the host/port fields should be removed and §18 updated) or it is supposed to work and is broken. Both interpretations need a fix; the current state is doc/code drift.
- **Cost:** M — wiring the live SyncServer port into managed state and through to `start_pairing_inner` is small, but the architectural question (do we need scan-bootstrapped pairing at all, or only passphrase + mDNS?) is a decision point per AGENTS.md "Architectural Stability".
- **Risk:** Medium (touches SyncServer plumbing)
- **Impact:** Medium
- **Recommendation:** Decide intent with the user. If the QR carries a real `host:port`, thread the SyncServer's bound `(local_ip, port)` into the wrapper; if not, drop those fields from `pairing_qr_payload` + `PairingInfo` and update §18. **Requires user approval per AGENTS.md Architectural Stability — wire-format choice between bind-address and rendezvous-string semantics.**
- **Pass-1 source:** 05/F19 (cross-ref 06/F2)
- **Status:** Open

### M-37 — `disconnect_gcal_inner` is not transactional across its three writes
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/gcal.rs:200-217`
- **What:** The function performs four side effects that should succeed-or-fail together: (1) clear `CalendarId` setting (line 202), (2) `DELETE FROM gcal_agenda_event_map` (line 203), (3) `token_store.clear()` (line 210), (4) clear `OauthAccountEmail` setting (line 217). None share a transaction; a failure between any two leaves a half-disconnected state (e.g. tokens gone but `account_email` still populated).
- **Why it matters:** The Settings tab can show "Connected as alice@example.com — keyring missing tokens", which is confusing. Recovery requires the user to click disconnect again and hope the second attempt succeeds atomically.
- **Cost:** M
- **Risk:** Medium — the three DB writes can be wrapped in a single `BEGIN IMMEDIATE`, but the keyring `clear()` cannot live inside a SQLite tx; ordering matters (do keyring clear first, so a DB failure leaves "tokens gone, settings still populated" — recoverable on next disconnect).
- **Impact:** Medium
- **Recommendation:** Reorder to (a) keyring clear (soft-fail per M-36), (b) one `BEGIN IMMEDIATE` wrapping the two `set_setting` calls + the `DELETE FROM gcal_agenda_event_map`, (c) emit `PushDisabled` after commit.
- **Pass-1 source:** 05/F13
- **Status:** Open


### Sync stack




### M-51 — Both file send and receive buffer the entire file in memory
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_files.rs:182-195` (`read_attachment_file`); `:233-326` (sender); `:436-455` (`receive_binary_data`)
- **What:** `read_attachment_file` does `std::fs::read(&full_path)` into a `Vec<u8>`, then `blake3::hash(&data)`, then chunks on the wire. The receiver accumulates all chunks into a single `Vec<u8>` before calling `write_attachment_file`. A 1 GB attachment requires ~1 GB of RAM on each side simultaneously.
- **Why it matters:** Phones with limited RAM will OOM during a single large attachment transfer (e.g., a screen recording). The same shape applies to snapshot transfer (see L-67). On Android this is a real ceiling.
- **Cost:** L
- **Risk:** Medium-High (rewrite both halves to streaming + streaming blake3)
- **Impact:** High (unblocks large attachments)
- **Recommendation:** Stream: open the source file, read 5 MB at a time into a fixed buffer, feed each chunk into a `blake3::Hasher` and `send_binary` the same chunk. Receiver writes incrementally to a temp file, finalises hash, renames atomically on success (and unlinks the temp file on failure). `blake3::Hasher` already supports incremental updates.
- **Pass-1 source:** 06/F16
- **Status:** Open





### Search & Links

### Lifecycle / Snapshots / Merge / Recurrence


### M-67 — `apply_snapshot` cache-rebuild tasks use `try_enqueue_background` (silent drop)
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/restore.rs:284-292`
- **What:** After committing the wipe+restore tx, the function enqueues 8 cache-rebuild tasks (FTS, agenda, projected agenda, tag inheritance, page IDs, tags, pages, block-tag refs) via `try_enqueue_background`, which silently drops with a `warn!` if the queue is saturated. There is no boot-time recheck that would re-enqueue dropped work.
- **Why it matters:** If the warn fires and no further op happens, FTS / agenda_cache / pages_cache / tags_cache stay empty indefinitely; the user sees an empty agenda/search/tag list with no actionable signal. Cross-references M-7 (`Materializer::try_enqueue_background` semantics).
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Use the awaiting `enqueue_background` variant for these post-RESET tasks (the apply path is exactly when stale caches matter), or persist a "needs rebuild" marker (new table — requires user approval per Architectural Stability) and gate startup on it.
- **Pass-1 source:** 08/F7
- **Status:** Open

### M-70 — `apply_snapshot` does not anchor the post-snapshot hash chain
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/restore.rs:89, 254`
- **What:** RESET does `DELETE FROM op_log` and commits without persisting the snapshot's `up_to_hash` anywhere as the post-restore anchor. The FEAT-6 sync orchestrator at `sync_daemon/snapshot_transfer.rs:326-352` does call `peer_refs::update_on_sync` immediately after, so the happy path is covered — but the contract is caller-enforced and there is no test asserting the next local op's `prev_hash` matches the snapshot's `up_to_hash`.
- **Why it matters:** A future caller of `apply_snapshot` outside the FEAT-6 orchestrator that forgets to anchor would silently break later cross-device hash-chain validation.
- **Cost:** M
- **Risk:** Medium
- **Impact:** High
- **Recommendation:** Audit every caller of `apply_snapshot` and add a regression test that asserts the next `append_local_op` after `apply_snapshot` produces a hash consistent with `up_to_hash`. Consider reshaping the return type (e.g., a `RestoreAnchor` newtype the caller must consume) so the anchor cannot be silently dropped.
- **Pass-1 source:** 08/F11
- **Status:** Open

### M-71 — `compute_reverse(restore_block)` translates back to bare delete_block
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/reverse/block_ops.rs:78-83`
- **What:** Reverse-of-restore is `DeleteBlockPayload { block_id }`; the original `RestoreBlockPayload`'s `deleted_at_ref` is discarded. A subsequent `cascade_soft_delete` mints a fresh `deleted_at` timestamp, breaking the original cascade-group identity. Undo→redo→undo→redo is therefore asymmetric on the timestamp group used by the Trash UI.
- **Why it matters:** Trash view groups by `deleted_at` string (ARCHITECTURE.md §2 "Cascade delete and Trash"); inverse-op generation should preserve groupability if it can. The user-visible effect is timestamp groups in Trash being lost across undo cycles.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Either accept the asymmetry and document it in the reverse-op module docs and the Trash UI spec, or carry the original `deleted_at_ref` through a new payload field — the latter requires user approval per Architectural Stability (op-payload extension). Pinning the current behaviour with a regression test is the minimum.
- **Pass-1 source:** 08/F12
- **Status:** Open

### M-81 — `cascade_soft_delete` ignores conflict copies — orphaned
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/soft_delete/trash.rs:46-55`
- **What:** The recursive CTE filters `b.is_conflict = 0` per invariant #9. A conflict copy whose source is in the cascade subtree is preserved (correct per the invariant), but its `parent_id` points into the now-soft-deleted subtree. After cascade, the conflict copy is reachable by direct lookup but invisible to any descendants walk that filters `deleted_at IS NULL` — orphan blocks floating with no parent context.
- **Why it matters:** Conflict-copy lifecycle has no clear story when the source's subtree is deleted; Trash view excludes conflict copies, so users cannot manually clean them up.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Discuss with user — semantics decision. Options: (a) include conflict copies in the cascade (relaxes invariant #9 for `cascade_soft_delete` only); (b) re-parent conflict copies to the cascade's nearest non-deleted ancestor and log; (c) document the orphan state and add a "review orphans" UI surface. Any of these may need user approval per Architectural Stability.
- **Pass-1 source:** 08/F27
- **Status:** Open

### MCP

### M-85 — `list_tags` / `list_property_defs` / `get_agenda` lack cursor pagination
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:384-401` (list_tags schema), `src-tauri/src/mcp/tools_ro.rs:403-413` (list_property_defs), `src-tauri/src/mcp/tools_ro.rs:415-453, 528-548` (get_agenda); inners `src-tauri/src/commands/tags.rs:257-262`, `src-tauri/src/commands/properties.rs:459-469`, `src-tauri/src/commands/agenda.rs:117-122`.
- **What:** Three list-style RO tools return a flat `Vec<...>` with a server-side cap (100/500) and no `cursor` / `next_cursor` / `has_more` field, in violation of AGENTS.md invariant #6 ("Cursor-based pagination on ALL list queries — no offset pagination"). The other list tools (`list_pages`, `get_page`, `search`, `list_backlinks`) do paginate, so the asymmetry is internal.
- **Why it matters:** A power user with thousands of agenda entries (multi-year repeating tasks) or hundreds of tags hits a silent ceiling; nothing in the response signals truncation. The hard invariant is the invariant, and the MCP layer is the only place it currently leaks.
- **Cost:** M
- **Risk:** Low (extending shared `*_inner` helpers must stay backward-compatible with frontend callers)
- **Impact:** Medium
- **Recommendation:** Either extend the inners to return a `PageResponse<T>` with cursors (modeled on `list_pages_inner`) and surface them in the MCP schema, or — as a backward-compatible interim — add a `truncated: bool` field to the response and document the cap. **Requires user approval per AGENTS.md Architectural Stability — adds cursor pagination to the public MCP tool surface.**
- **Pass-1 source:** 09/F5
- **Status:** Open

### GCal / Spaces / Drafts

### M-90 — `is_space` typed as `text`; equality probed on the literal string `"true"`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `migrations/0035_spaces.sql:6-7`; `src-tauri/src/spaces/bootstrap.rs:101, 169-179`; `src-tauri/src/commands/spaces.rs:48-56`
- **What:** The `is_space` property is registered with `value_type = 'text'` and every is-space probe filters by `value_text = 'true'` (literal lowercase). `property_definitions` does not declare `options = '["true"]'`, so `set_property_in_tx`'s options-membership guard does not enforce the value. Any peer / future UI that writes `"True"`, `"yes"`, `"1"` — or uses `value_num` / `value_ref` — silently disappears from `list_spaces`.
- **Why it matters:** A type-safe boolean flag this central to FEAT-3 deserves stricter modelling. Today the convergence invariant only holds because bootstrap is the *only* writer of `is_space`; that is fragile to extend (a future "rename space" or "promote page to space" affordance would have to remember the convention).
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) change the `is_space` property type from `text` to `select` with `options = '["true", "false"]'` so `set_property_in_tx`'s options-membership guard kicks in (the current `text` type bypasses that guard — `commands/blocks/crud.rs:1190` only enforces options when `expected_type == "select"`), **or** (b) pivot the test to check non-empty truthy `value_text` in the queries. Prefer (a) for type safety. Add a test that `set_property` with `value_text='True'` is rejected once the type is changed.
- **Pass-1 source:** 10/F12
- **Status:** Open

### M-91 — `create_page_in_space_inner` does not require parent and child to share the same space
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/commands/spaces.rs:100-167` (parent path); test gap at `src-tauri/src/commands/spaces.rs:680-723`
- **What:** When `parent_id` is supplied, the helper validates only that `space_id` resolves to a live `is_space='true'` block; it never checks the parent's `space` property matches. A frontend that resolves `parent_id` from one space's tree but submits `space_id` for another succeeds and lands an op pair where the new page belongs to space X but its parent belongs to space Y.
- **Why it matters:** REVIEW-LATER.md FEAT-3 pins "Nothing outside of spaces. … No cross-space 'show everything' view." Cross-space parents undermine the "page sets are disjoint and their union is total" invariant — recursive CTE walkers that follow `parent_id` will then traverse across space boundaries.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Inside the `create_page_in_space_inner` tx, when `parent_id` is `Some`, fetch the parent's `space` ref-property and reject with `AppError::Validation` if it differs from `space_id`. Add a regression test `(parent in Personal, space_id=Work)` asserting the create fails and no ops are appended.
- **Pass-1 source:** 10/F13
- **Status:** Open

### M-92 — `bootstrap_spaces`'s `pages_without_space` migration does N round-trips for N pages
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/spaces/bootstrap.rs:59-73`
- **What:** First-boot migration loops over every legacy unscoped page and calls `set_property_in_tx` once per page. Each call does ~4 SQL round-trips (property-defs lookup, block existence probe, op_log append, `INSERT OR REPLACE INTO block_properties`). For a 5000-page vault this is ~20k queries inside one transaction held for the whole bootstrap.
- **Why it matters:** `bootstrap_spaces` is awaited synchronously from `lib.rs` setup and is documented as boot-fatal; a long single transaction risks WAL pressure, lock contention with the materializer, and a noticeable startup stall before the UI renders. It also blows up the partial-crash-resumability surface that bootstrap.rs's docstring promises.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Cache the `property_definitions` row once outside the loop, batch the `block_properties` upsert (chunked `INSERT OR REPLACE … VALUES (?), (?), …` per ~500 ids), and stream op_log appends in chunks of ~1000 with intermediate commits so a partial crash leaves a partial migration that the fast-path probe re-detects. No new tables / op types — stays inside Architectural Stability bounds.
- **Pass-1 source:** 10/F14
- **Status:** Open

### M-93 — `block_drafts` table has no FK to `blocks`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `migrations/0001_initial.sql:67-71`; `src-tauri/src/draft.rs`; `ARCHITECTURE.md §12 Crash Recovery`
- **What:** `CREATE TABLE block_drafts (block_id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL)` declares no foreign key to `blocks(id)` — even though AGENTS.md sets `PRAGMA foreign_keys = ON` globally. The crash-recovery walk emits synthetic `EditBlock` ops for surviving drafts, so a draft whose block was hard-deleted produces a no-op edit for a missing target.
- **Why it matters:** Combined with H-12 (flush_draft does not validate the target block exists) this is the channel through which orphan ops enter the append-only log on every boot. The op log is supposed to be source-of-truth and append-only; orphan edits inflate compaction and complicate forensics.
- **Cost:** S (migration) — but **Risk Medium** because it changes drop semantics
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Add a migration `block_id REFERENCES blocks(id) ON DELETE CASCADE`. **Requires user approval** under AGENTS.md §"Architectural Stability" (new schema constraint on a shipped table). Pair with H-12's existence check so flush also short-circuits on missing/soft-deleted blocks. Document the cascade interaction with soft-deletes (drafts survive soft-delete, are wiped on hard-delete/purge).
- **Pass-1 source:** 10/F18
- **Status:** Open

### M-94 — JWT `id_token` signature is not verified before extracting the email claim
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/oauth.rs:619-647`
- **What:** `extract_email_from_id_token` base64-decodes the JWT payload and reads `email` without verifying the RS256 signature against Google's JWKS. The doc explicitly accepts this on the grounds that the token came over TLS direct from Google's token endpoint and the email is "display-only".
- **Why it matters:** Per the user's threat-model carve-out, gcal_push is internet-facing — so OAuth token handling is in scope. The email is persisted to `gcal_settings.oauth_account_email` and shown in Settings; an unverified claim could mislead the user about which Google account is connected. In practice spoofing requires compromising the TLS channel (no realistic attacker today), but the posture is fragile if the token ever flows through a non-direct channel (proxy, Android browser handoff, FEAT-5g).
- **Cost:** M (JWKS fetch + cache + RSA verify; e.g. `jsonwebtoken` crate)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either (a) implement full JWKS-based verification (cache JWKS, verify RS256, accept on `iss == https://accounts.google.com`, fail closed) **or** (b) keep the current behaviour and tighten the docstring + tracing to mark the email as `unverified_email` everywhere it surfaces. Option (a) is the right answer once FEAT-5g (Android) lands; (b) is acceptable while desktop-only.
- **Pass-1 source:** 10/F19
- **Status:** Open

### M-95 — `recover_calendar_gone` does not also clear `oauth_account_email`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/connector.rs:727-741`
- **What:** When the calendar is gone, the connector wipes the event map and resets `calendar_id`, but `oauth_account_email` is left untouched. The Settings UI continues to show "connected as user@example.com" while the connector has just reset to "no calendar yet".
- **Why it matters:** Cosmetic UX consistency — does not affect correctness of the push pipeline. Listed Medium in the M- numbering for parity with M-89's transaction concern, but this is purely a Settings-tab display drift.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either leave as-is (the email is still the right one — only the calendar reset) or, if FEAT-5f explicitly differentiates "connected, no calendar yet" from "calendar recreated since last open", refresh `oauth_account_email` from the most recent token's id_token claim during the recreate path. Lean toward leaving as-is unless FEAT-5f spec calls for the distinction.
- **Pass-1 source:** 10/F23
- **Status:** Open

### L-133 — `space` ref-property invariant relies on bootstrap migration but never re-runs
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/spaces/bootstrap.rs:39-86, 92-110`
- **What:** `is_bootstrap_complete` returns `true` as soon as both seed-space blocks exist with `is_space='true'`, after which `pages_without_space` never runs again. Pages that land in DB without a `space` property after bootstrap (cf. H-3 — JournalPage / TemplatesView creating unscoped pages, plus any peer-synced legacy CreateBlock op) stay unscoped forever — invisible to space-scoped list queries.
- **Why it matters:** Combined with the H-3 leak, this is the mechanism by which the FEAT-3 invariant decays: every new daily-journal page enters DB unscoped and never gets a `space` property. The bootstrap test (`bootstrap_skips_pages_that_already_have_space_property`) only pins that bootstrap is conservative — there is no follow-up sweep.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Fix H-3/H-4 first (frontend stops creating unscoped pages). Then either (a) extend the bootstrap fast-path to also assert `pages_without_space()` is empty (surfaces drift loudly with a boot-fatal error) or (b) add a periodic background sweep that assigns orphans to the user's "current" space (or Personal as fallback). Prefer (a) — option (b) obscures bugs.
- **Pass-1 source:** 10/F26
- **Status:** Open

## LOW findings (7 — expanded)

> Each entry is a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status).

### Materializer

### L-17 — `dispatch_op` enqueues fg+bg out of order
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/dispatch.rs:98-102`
- **What:** `dispatch_op` calls `enqueue_foreground(ApplyOp(record))` then `enqueue_background_tasks(record, None)`. The two queues have independent consumers — the bg consumer can pull e.g. `RebuildTagsCache` and execute it before the fg consumer has applied the `CreateBlock(tag)` to `blocks`. The cache rebuild then reads pre-op state and `tags_cache` stays stale until the next op happens to re-enqueue the rebuild. Production paths use `dispatch_background_or_warn` *after* the command has committed the op, so this race is mostly limited to test code (and `sync_daemon/snapshot_transfer.rs:451`, which is itself a test helper); it is downgraded from Medium for that reason.
- **Why it matters:** For the test paths (and the snapshot-transfer test helper) it shrinks the window of correctness for the very-first op of its kind. If `dispatch_op` is ever adopted on a production code path it becomes a real correctness hazard ("created a tag, search doesn't find it" until I create another).
- **Cost:** M (2-8h)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either (a) move the bg fan-out *into* the fg consumer so it runs only after `apply_op_tx` commits — making the consumer the single scheduler of per-op derived work; or (b) thread a `Notify` keyed on `(device_id, seq)` and have the bg side `notified().await` before running the rebuild it spawned. (a) is cleaner.
- **Pass-1 source:** 02/F10
- **Status:** Open

### Commands System

### L-53 — `cancel_pairing` clears pairing slot whether or not a session exists
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:152-158`
- **What:** `cancel_pairing_inner` sets the slot to `None` unconditionally and returns `Ok(())`; there is no error if no session was active. Combined with the lack of validation in `confirm_pairing_inner` (Pass-1 F16), the entire `pairing_state` slot is effectively write-only — only `start_pairing` writes it; `confirm_pairing` and `cancel_pairing` always overwrite with `None`.
- **Why it matters:** Symptom of broader pairing-state ownership confusion. Once the F16 fix lands (`confirm_pairing` actually validates against the slot), this becomes the natural "no-op if absent" path; until then, the slot has no observable effect.
- **Cost:** N/A (closes alongside the F16 fix tracked elsewhere as a High in REVIEW-LATER)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Bundle into the F16 / confirm_pairing fix; once `confirm_pairing` reads and validates the slot, `cancel_pairing` can keep its current "no-op if empty" semantics with a debug log.
- **Pass-1 source:** 05/F32
- **Status:** Open

### L-55 — `redact_log` newline split-and-rejoin is O(n²) in the worst case
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:229-242` (`redact_log`), `src-tauri/src/commands/bug_report.rs:202-226` (`redact_line`)
- **What:** `redact_log` iterates `split_inclusive('\n')`, calls `redact_line` (which does two `String::replace` calls — each a linear scan with allocation: home, then device_id), then pushes back into `out`. For a 2 MB file this is two full-buffer linear scans per line, multiplied by the line count. `MAX_LINE_BYTES` truncation happens *after* the replace, so the replace itself sees the original full-length line.
- **Why it matters:** A bug report on a workstation with thousands of large stack-trace lines could take seconds. Mitigated by the 2 MB file cap.
- **Cost:** M — switch to a single-pass replacer (e.g. `aho_corasick` or a hand-written matcher over the static needles).
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Acceptable as-is until profiling shows it is a bottleneck; lower priority than M-31 / L-41. If/when fixed, a single-pass `replace_n` over both needles avoids allocations.
- **Pass-1 source:** 05/F35
- **Status:** Open

### Sync

### L-65 — mDNS `enable_addr_auto()` announces on every interface
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/websocket.rs:43-66` (`announce`)
- **What:** `service_info = …enable_addr_auto();` lets `mdns-sd` enumerate every routable interface for announcements. On a multi-homed device (laptop docked at home + tethered to phone hotspot + on a guest WiFi) the announcement leaks the device IP to networks the user might not intend.
- **Why it matters:** Not an "adversary" issue — but the user may not want their phone advertising on every coffee shop's network. UX/privacy choice, not hardening.
- **Cost:** M (interface filtering policy is OS-specific)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Defer to user approval — this is a UX choice. Possible directions: (a) restrict to `IFF_PRIVATE`-flagged interfaces, (b) expose a setting "announce on this network only", (c) accept current behaviour and document it. Do not change without user input.
- **Pass-1 source:** 06/F37
- **Status:** Open

### L-67 — Snapshot receiver allocates a single `Vec<u8>` of up to 256 MB
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/snapshot_transfer.rs:372-405`; cap at `:285-300` (`MAX_SNAPSHOT_SIZE`)
- **What:** `let capacity = usize::try_from(size_bytes).unwrap_or(usize::MAX); let mut data: Vec<u8> = Vec::with_capacity(capacity);` — the cap enforcement at line 285-300 bounds the allocation to 256 MB, but the entire payload is buffered before `apply_snapshot`. Note this is **not** the same shape as the OUT-OF-SCOPE F11/F12 (no unbounded behaviour: the cap exists and works); just a perf concern.
- **Why it matters:** Large initial onboarding via snapshot is a real path; on Android with limited RAM, 256 MB plus the decompression+restore working set can OOM the daemon. Cap is correct, footprint is not.
- **Cost:** M
- **Risk:** Medium (cross-cutting refactor of `apply_snapshot` to take `impl Read`)
- **Impact:** Medium
- **Recommendation:** Stream-decode into a temp file (or a bounded ring buffer) and refactor `apply_snapshot` to accept `impl Read` so `zstd::stream::Decoder + tokio::io::copy` can pipe through. Pair with M-51 since the patterns are siblings.
- **Pass-1 source:** 06/F40
- **Status:** Open

### Search & Links

### MCP

### L-118 — TOCTOU race on rapid `mcp_set_enabled` toggling
- **Domain:** MCP
- **Location:** `src-tauri/src/commands/mcp.rs:212-244` (`mcp_set_enabled`, in particular the `lc.is_running()` read at line 232); `src-tauri/src/mcp/mod.rs:275-296` (`bind_socket` already-bound probe).
- **What:** `mcp_set_enabled(true)` reads `lc.is_running()` without a lock and conditionally calls `spawn_mcp_ro_task`. A second concurrent `mcp_set_enabled(true)` may also see `task_running == false` (because the first spawn has not yet reached `bind_socket`) and double-spawn. The second `bind_socket` then detects the live socket via the `UnixStream::connect` probe and returns `AppError::InvalidOperation("already bound")`, logged at warn.
- **Why it matters:** Pure cosmetic: the worst observable artifact is a single warn line. Local-only deployment makes accidental rapid toggles vanishingly rare.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Leave as-is per Pass 2's "leave-as-is" finding; the warn log is sufficient diagnostic. If a clean fix is desired, add a `spawning: AtomicBool` on `McpLifecycle` and gate the spawn with `compare_exchange`.
- **Pass-1 source:** 09/F11
- **Status:** Open

### M-84 — `journal_for_date` is exposed on the RO server but writes to op_log
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:182-208` (module doc), `src-tauri/src/mcp/tools_ro.rs:212-224` (9-tool list), `src-tauri/src/mcp/tools_ro.rs:245-263` (ACTOR scope), `src-tauri/src/mcp/tools_ro.rs:550-564` (handler); REVIEW-LATER.md FEAT-4 line 199 (lists `journal_for_date` as RO).
- **What:** `ReadOnlyTools` carries a `device_id` and a writer-capable `Materializer` solely so `journal_for_date` can call `create_block_inner` for missing dates. The resulting op lands in `op_log` with `origin = "agent:<name>"`. The user toggling on the **read-only** marker therefore implicitly grants "agent can append a `create_block` for a journal page", and the user-facing copy in Settings does not surface this.
- **Why it matters:** Even in the local-only model, the Settings tab labels this as a read-only surface; an agent calling `journal_for_date` for an unseen date adds an entry to the recent-activity feed that the user did not consent to in mental-model terms. Pass 2 downgraded the severity (no security impact), but the wording drift is real.
- **Cost:** S (docs/UI label) — L (split tool requires user approval per AGENTS.md "Architectural Stability")
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Update the Settings tooltip and the FEAT-4 doc to say "RO tools may create a journal page on first read-of-the-day"; do not split the tool without explicit user approval since changing the MCP tool surface is a public API change.
- **Pass-1 source:** 09/F4
- **Status:** Open

### GCal / Spaces / Drafts

### L-132 — `claim_lease` does 4 round-trips, could be 2
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/lease.rs:140-218`
- **What:** Inside one `BEGIN IMMEDIATE` tx, `claim_lease` does 2 single-key SELECTs (`push_lease_device_id`, `push_lease_expires_at`) and then 2 single-key UPDATEs. Could be one batched SELECT (`WHERE key IN (...)`) and one batched UPDATE (`SET value = CASE key WHEN ... END WHERE key IN (...)`).
- **Why it matters:** Lease cycle runs at `LEASE_RENEW_INTERVAL_SECS = 60s` once C-1 is fixed. Per-cycle cost is negligible; flagged for completeness.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Defer until profiling shows it matters. If the connector ever drops to a sub-second cycle, batch the reads and writes.
- **Pass-1 source:** 10/F25
- **Status:** Open

---

## Closing notes

- The Pass-1 reviewers were unusually accurate: across 348 findings, only 2 outright hallucinations and 5 out-of-scope claims. Severity inflation was the dominant correction (49 downgrades).
- The `sanitize_internal_error` doc/code drift in particular is a recurring pattern: ARCHITECTURE.md §15 over-claims; five command files actually skip the helper. Pass 2 was right to downgrade this from "Security/High" to "Docs/Low" — the helper's own docstring says it's UX-only.
- The most consequential pattern is the **ApplyOp permanent-failure black hole** (C-2). Fixing it likely doesn't require new schema — a boot-time replay path against `op_log` would close the loop within the existing CQRS model — but it's the single most impactful change available.
- **GCal connector dead code (C-1)** is fixable in a single afternoon if the `run_cycle` is genuinely correct (Pass 2 confirmed it is, per its tests). The fix is wiring, not redesign.
- Fixing **C-3 (attachment file leak)**, **H-1 (pairing passphrase)**, **H-2 (MCP toggle)**, and **H-3 (create_page_in_space bypass)** together would close the four most user-visible behavioral defects in the codebase. None require architectural change beyond one carrying `fs_path` in `DeleteAttachment` (op log payload extension, allowed under Architectural Stability).
