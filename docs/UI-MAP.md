<!-- markdownlint-disable MD060 -->
# Agaric UI Map

Shared vocabulary + surface tree. Read this before any UI conversation so we agree on what "the toolbar" or "the picker" means. Self-contained; companion to `docs/UX.md` (conventions) and `AGENTS.md` (architectural invariants).

## Glossary

Names below are how we refer to each surface in conversation. They mostly match the PascalCase component name; where the component name is long, the glossary name is short.

| Glossary name | What it is | Component / module |
| --- | --- | --- |
| **AppShell** | Persistent chrome (sidebar + header + tab bar + scroll area) around the active view. | `App.tsx` |
| **BootGate** | Loading / error overlay shown until the DB pool + materializer are ready. | `BootGate.tsx` |
| **Sidebar** | Left-rail nav. Desktop = persistent collapsible. Mobile = persistent icon rail + Sheet overlay. | `AppSidebar.tsx` |
| **TabBar** | Hoisted tab strip above the view. Hidden on mobile and when only one tab. | `TabBar.tsx` |
| **PageHeader** | Sticky title bar for the page-editor view (title, breadcrumb, aliases, tags, properties, kebab menu). | `PageHeader.tsx` |
| **ViewDispatcher** | Single source of truth for which view renders. Store-driven (no router). | `ViewDispatcher.tsx` |
| **JournalPage** | The default view — daily / weekly / monthly / agenda modes of dated blocks. **Only eager view**; everything else is React.lazy. | `JournalPage.tsx` |
| **PageEditor** | Single-page editor (title + BlockTree). Opened via link / nav, not in the sidebar. | `PageEditor.tsx` |
| **BlockTree** | The editor render tree. Owns DnD + keyboard + multi-select + history wiring. | `BlockTree.tsx` |
| **EditableBlock** | The block that currently hosts the **roving** TipTap editor. | `EditableBlock.tsx` |
| **StaticBlock** | Every non-focused block — renders read-only markup via RichContentRenderer. | `StaticBlock.tsx` |
| **RichContentRenderer** | Read-only renderer dispatching markdown nodes to per-type mark / block components. | `RichContentRenderer/` |
| **FormattingToolbar** | Always-visible per-block toolbar (links, structure, metadata, history, overflow popover). | `FormattingToolbar.tsx` + `FormattingToolbar/` |
| **SelectionBubbleMenu** | Contextual mark toolbar (Bold / Italic / Code / Strike / Highlight + External Link) on non-empty selection. | `SelectionBubbleMenu.tsx` |
| **SuggestionList** | Shared popup for every inline picker (`[[`, `@`, `((`, `/`, `::`). | `SuggestionList.tsx` |
| **BlockLinkPicker** / **TagPicker** / **BlockRefPicker** / **SlashMenu** / **PropertyPicker** | The five inline pickers, all rendered through SuggestionList. | TipTap extensions under `src/editor/extensions/` |
| **BlockPropertyDrawer** | Slide-out sheet of typed property editors for a block. | `BlockPropertyDrawer.tsx` |
| **PropertyRowEditor** | One typed property row inside the drawer. | `PropertyRowEditor.tsx` + `PropertyRowEditor/` |
| **SortableBlockWrapper** | DnD wrapper around each block. Owns the offscreen-placeholder optimisation. | `SortableBlockWrapper.tsx` |
| **SpaceSwitcher** | Sidebar header dropdown for active space. Collapses to **SpaceAccentBadge** in icon-rail mode. | `SpaceSwitcher.tsx` |
| **SpaceAccentBadge** | Collapsed-state space indicator; click cycles to next space. | `SpaceAccentBadge.tsx` |
| **SpaceManageDialog** | Create / rename / delete spaces. | `SpaceManageDialog/` |
| **ConfirmDialog** | Unified confirm wrapper — async-aware, swaps to bottom Sheet on mobile. | `ConfirmDialog.tsx` |
| **MenuPopoverContent** | Canonical popover content wrapper for menu-style popovers. Use over plain `PopoverContent` for any menu-shaped surface. | `ui/menu-popover-content.tsx` |
| **Announcer** | Singleton `aria-live="polite"` region. See `docs/UX.md` § Accessibility for the coalescing rule. | `src/lib/announcer.ts` |
| **Toaster** | sonner; bottom-right on desktop, top-center on mobile. Use `notify()` helper. | `Toaster` + `src/lib/notify.ts` |
| **`data-editor-portal`** | HTML attribute every overlay anchored from inside the editor must carry, so the roving editor's blur handler doesn't fire when you click into the overlay. | Read by `useEditorBlur` |

## Top-level shell

```text
App
├── BootGate                     (loading / error gate)
├── SpaceTopStripe               (3px accent bar)
├── SidebarProvider
│   ├── AppSidebar               (collapsible left rail)
│   └── SidebarInset
│       ├── Header bar           (view-specific controls)
│       ├── TabBar               (hoisted; desktop & multi-tab only)
│       ├── RecentPagesStrip     (desktop chip grid)
│       ├── ViewHeaderOutletSlot (sticky page header outlet)
│       └── ScrollArea
│           └── ViewDispatcher → one of the Views below
├── Suspense
│   ├── KeyboardShortcuts        (lazy, ? hotkey)
│   ├── WelcomeModal             (lazy, first-run)
│   ├── BugReportDialog          (lazy)
│   ├── QuickCaptureDialog       (lazy, global hotkey)
│   └── NoPeersDialog            (lazy, sync-empty fallback)
└── Toaster
```

## Views

`ViewDispatcher` switches on `useNavigationStore.currentView`. No router; no URL hash. `agaric://` deep links are parsed by the Rust backend, emitted as Tauri events, and dispatched into the nav / tabs stores. `useTabsStore` owns the per-tab page stack.

| View | What the user sees | Sidebar item |
| --- | --- | --- |
| **Journal** | Eager-mounted; daily / weekly / monthly / agenda sub-modes share one date cursor. | Calendar |
| **Search** | Debounced + cursor-paginated FTS; filter chips for pages and tags. Cmd/Ctrl+F also focuses it. | Search |
| **Pages** | Virtualised list of all page blocks; multi-select + delete. | FileText |
| **Tags** | Tag CRUD + colour picker + filtered task panel. | Tag |
| **Properties** | Property-definition CRUD. Not in the sidebar — reachable from links / nav state only. | — |
| **Settings** | Tabbed; deep-linkable via the `?settings=<tab>` query string parsed inside `SettingsView` (no real router). | Settings |
| **Trash** | Soft-deleted blocks; batch restore / purge; original-location breadcrumb. Badge polls periodically. | Trash |
| **Status** | Materializer metrics (queue depths, op counts). Polls periodically. | Activity |
| **History** | Global op log; multi-select revert; diff toggle. | History |
| **Templates** | Template-tagged pages with first-block preview. | LayoutTemplate |
| **Graph** | Force-directed page-relationship graph. Web Worker; reduced-motion friendly. | Network |
| **PageEditor** | Single page (title + BlockTree). Reached by navigation, not the sidebar. | — |

The **DuePanel** and **DonePanel** are not separate views — they're children of the Journal modes (agenda, daily, weekly). Clicking a Due / Done badge scrolls into view inside the active mode rather than switching views.

## Editor surfaces

### Single-roving-editor invariant

Only one block mounts `<EditorContent>` at a time. Focus moves → editor unmounts from the previous block (after persisting) and remounts in the new one. Bounded memory; per-session undo isolation.

### Toolbar pair

- **FormattingToolbar** — always visible above the focused block. Buttons grouped by purpose; low-priority items overflow into a `MoreHorizontal` popover when narrow. Internals layout: `FormattingToolbar/items.ts` owns the priority-flatten + `useToolbarOverflow` measurement; group renderers live in sibling files (`RefsAndBlocksGroup.tsx`, `MetadataGroup.tsx`); shared dispatch primitives in `shared.tsx`. To add a button, add it to the matching group + its priority + an i18n key.
- **SelectionBubbleMenu** — appears only on non-empty selection; hosts the mark toggles + the External Link button.

Both toolbars use `onPointerDown + preventDefault()` so clicks never steal focus.

### Inline pickers

All five route through **SuggestionList**, registered as TipTap extensions:

| Trigger | Picker            | Inserts                                       |
| --- | --- | --- |
| `[[`    | BlockLinkPicker   | `block_link` node (ULID)                      |
| `@`     | TagPicker         | `tag_ref` node (ULID)                         |
| `((`    | BlockRefPicker    | `block_ref` node (ULID)                       |
| `/`     | SlashMenu         | varies by category                            |
| `::`    | PropertyPicker    | `key::` text; parent wires `setProperty`      |

`@floating-ui/dom` positions them. Each opt-in carries `data-editor-portal=""` on its outermost element.

**Adding a new picker:** copy an existing extension (e.g. `at-tag-picker.ts`) as a template, use the shared `createPickerPlugin` + `resolveAndInsertPickerToken` helpers in `picker-plugin.ts`, register the extension in the TipTap setup, and set `data-editor-portal=""` on the popup root. Trigger characters are not user-rebindable.

### Slash commands

Composed from category sub-hooks under `src/hooks/useBlockSlashCommands/` plus a merge step. To add a command: drop it in the matching sub-hook, add the i18n key, and wire any new handler.

### Drag-and-drop

`useBlockDnD` owns sensors + state. Depth projection on every drag move (horizontal offset ÷ indent-width, clamped to sibling bounds). Offscreen blocks become zero-height placeholders to preserve scroll position. The focused block never virtualises during a drag.

## Navigation chrome

- **Sidebar** — header (logo + SpaceSwitcher), body (nav items), footer (action buttons). Open/closed state persists in a cookie; width in localStorage.
- **PageHeader** owns the page title, alias section, tag row, property table, and a kebab menu. See `docs/UX.md` § App-specific features → Kebab menu for the canonical action list.
- **Keyboard shortcuts** live in `src/lib/keyboard-config/catalog.ts` and are user-customisable in Settings → Keyboard. Picker-trigger characters (`/`, `@`, `[[`, `((`, `::`) are not rebindable.
- **Search entry points**: `Ctrl/Cmd+F`, sidebar Search button. Both land in `SearchPanel`.
- **Space switcher**: `Ctrl+1`-`Ctrl+9` map to the first nine spaces. `currentSpaceId` lives in `useSpaceStore`; each space has its own `currentView` slice, so switching spaces restores the last view that space was on.

## Dialogs, popovers, sheets

All modal-style dialogs use `useDialogOrSheet`, which swaps to a bottom Sheet on viewports below the mobile breakpoint. Popovers anchored from inside the editor must set `data-editor-portal=""` on their outermost element.

| Dialog / popover                          | Trigger                                                                |
| --- | --- |
| **ConfirmDialog**                         | Generic confirm; destructive variant focuses Cancel                    |
| **SpaceManageDialog**                     | Sidebar → SpaceSwitcher → Manage                                       |
| **PairingDialog**                         | Sidebar Sync button (when peers missing → NoPeersDialog routes here)   |
| **BugReportDialog**                       | Help menu / global error flow                                          |
| **QuickCaptureDialog**                    | Global OS hotkey (default Ctrl+Alt+N)                                  |
| **PdfViewerDialog**                       | PDF attachment click                                                   |
| **HistoryRestoreDialog** / **HistoryRevertDialog** | History view actions                              |
| **TrashPurgeDialog** + batch variants     | Trash view actions                                                     |
| **LinkEditPopover**                       | FormattingToolbar External Link / SelectionBubbleMenu Link             |
| **AddPropertyPopover**                    | "+ Add" inside property surfaces                                       |
| **DateChipEditor**                        | Agenda date chips                                                      |
| **PageHeaderMenu**                        | Kebab in PageHeader                                                    |
| **FormattingToolbar overflow**            | `MoreHorizontal` when toolbar narrows                                  |
| **SearchablePopover**                     | Page / tag pickers inside Search filters                               |

## Mobile / a11y posture

- **44 px touch floor** via `[@media(pointer:coarse)]` classes (`min-h-11`, etc.). Enforced in `Button` variants and overflow menu rows. Inline indicators (collapse chevron, task marker, priority badge) intentionally use the `max-sm:` viewport breakpoint instead — they compete with content for space and are not touch-primary affordances. Don't unify the two — tests assert both.
- **Sidebar mobile model**: persistent 48 px icon rail + Sheet overlay (left-edge swipe or hamburger toggle). Sheet auto-closes on nav-item tap.
- **No Sheet ↔ Popover viewport swaps**. Radix Popover works on touch; Sheet is only for off-canvas navigation.
- **ARIA, focus, announcer, reduced motion** — see `docs/UX.md` § Accessibility for the canonical rules. Notable here: roving tabindex (exactly one `tabindex=0` per group, arrows move it) is used in `SearchablePopover`, `RecentPagesStrip`, `TabBar`; the block editor's mount/unmount-by-focus is a different pattern, the "roving editor".

## Pitfalls — things easy to get wrong

- **`data-editor-portal`** — any overlay anchored from inside the editor must set this attribute on its outermost portal node. Otherwise `useEditorBlur` fires when you click into it, the editor unmounts mid-interaction, and the popover disappears.
- **`onPointerDown + preventDefault()`** — every toolbar / popover trigger must use this combo, not `onClick`. Otherwise focus leaves the editor on press.
- **Capture `insertPos` before async** — picker plugins that await IPC must check `insertPos <= editor.state.doc.content.size` before inserting; the doc may have shrunk during the await. Fall back to insert-at-cursor when stale.
- **Roving editor flush before unmount** — call sites that destroy the focused block (collapse parent, delete, navigate away) must flush the editor's pending changes first.
- **Space-scoped state** — `currentView`, recent pages, tabs, journal mode are all stored per space. Switching spaces flips them. Anything you persist into nav state should pick the right slice.
- **`useDialogOrSheet` button semantics differ** — AlertDialog auto-closes on click; Sheet needs an explicit `onOpenChange(false)`.

## Improvements suggested

Findings surfaced during the doc audit + codebase pass. Each is a real drift / gap / inconsistency the user can act on independently. Not in this doc as an action item — kept here so the surface map is the canonical place to find "what's wrong with the UI surface".

- **Properties tab in Settings is wired up halfway.** The `settings.tabProperties` i18n key exists but `SettingsView` never branches on `activeTab === 'properties'` — the Properties view is reachable only via top-level nav state, not from inside Settings. Either remove the orphan key + finish the tab branch, or drop the key entirely.
- **Properties view has no sidebar entry.** `nav-items.ts` lists 10 nav items; Properties isn't one. Users can't navigate there from the chrome. If it's still a supported view, add the nav item; if not, fold it into Settings or remove it.
- **Toast deduplication.** sonner doesn't dedupe by default, and `notify()` doesn't either. Rapid identical errors (e.g. sync failures in a loop) stack visibly. Worth either threading a dedup helper into `notify()` or using sonner's `id` field for known-recurring-error categories.
- **Long-press constants moved out of `SortableBlock`.** Documentation that named `SortableBlock.tsx` as their home has rotted. Already corrected in `docs/UX.md`; verify other doc / comment references still point at `SortableBlock`.
- **Sidebar resize on mobile is a no-op** but the toggle still appears clickable in some collapsed states. Consider hiding the toggle entirely on mobile, or making the affordance match behaviour.
- **Toast action signature inconsistency.** Some callsites pass `toast.action`-style options, others wrap `notify()` with `t()`-keyed text. Standardising on `notify.error(msg, { action: { label, onClick } })` and adding a `notify.retry()` helper would tighten the API.
- **`max-sm:` vs `[@media(pointer:coarse)]` divergence is intentional** but invisible to first-time readers. The current convention (44 px touch floor for primary affordances, viewport-based hiding for inline indicators) is right; documenting the rule in a single place — `docs/UX.md` § Touch & responsive — and linking from comments would prevent future "unifications".
- **`MenuPopoverContent` adoption is partial.** Some popovers still use plain `PopoverContent` for menu surfaces. A grep + sweep would tighten visual consistency.
- **`KeyboardShortcuts` panel doesn't surface the deeplink `agaric://` scheme.** Power users don't know the scheme exists. A "Deep links" section in the panel — even just the three commands (`/block/<id>`, `/page/<id>`, `/settings/<tab>`) — would surface a hidden feature.
- **Quick-capture hotkey is OS-global.** It's powerful but unannounced inside the app. Consider a one-time tooltip / welcome-modal mention.
- **JSDoc i18n drift.** Several component JSDoc comments reference English strings that have since moved into `t()` calls. Not user-facing, but agents reading the JSDoc may infer wrong UI text. Low priority.
- **No CI lint to catch doc-vs-code drift.** Many of the corrections in this doc audit could be caught automatically by a script that greps the docs' `src/...` paths against the filesystem and fails CI on a miss. Optional but high-leverage.
