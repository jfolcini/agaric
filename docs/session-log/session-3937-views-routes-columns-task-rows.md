# Session 3937 — Views: labelled routes, query table columns, one task checkbox

#6544, its four open checkboxes after #6592. Three are built; tag colour from the synced `color` property is not, and the two sync items (bookmarks, saved views) wait for their design notes, as the issue says.

## Labelled routes

- **Premise held:** the Pages header's second row was five `IconButton`s (Tags, Graph, Advanced Query, Templates, Trash). The phone's ⋮ menu already names them; the sidebar was not touched.
- **Change:** they are `Button`s with the icon and the name. The name shows once the row's container is `@xl` wide (a container query, as the sidebar takes part of a tablet's width), and below that it is visually hidden, and the tooltip carries it. Each button keeps its name as `aria-label` (the real-backend specs select `button[aria-label="Advanced Query"]`), and Trash's carries its count.
- **Spec:** `e2e/pages-header-routes.spec.ts`. At 1280 px each label is wider than 20 px and its click opens the view.

## Query table columns

- **Premise held:** `detectColumns` derived the columns from the loaded rows.
- **Where the choice lives:** in the query block itself, so it syncs and needs no new IPC, store, table or op type.
  - A `v2:` query keeps it as an optional `columns` list in its JSON. The encoder writes it only when set, so a payload without it is byte-identical to before.
  - A text query keeps it as `columns:a,b`.
  - `readQueryColumns` and `writeQueryColumns` (`src/lib/query-result-columns.ts`) handle both forms.
  - The builder keeps the list when it saves a query.
- **Picker:** a columns button beside the edit button, in table mode on a block. It has checkboxes, move-left/right and *Columns from the results*.
- **Click capture:** `StaticQueryBlock`'s capture handler now yields to `[data-slot="popover-content"]`, because React bubbles the picker's portal clicks into it.
- **Extraction:** the column logic moved to `use-query-table-columns.ts`, which kept `QueryResult` under its complexity cap. `detectColumns` is re-exported.
- **Rust (read only):** `InlineQuerySpec` in `src-tauri/src/commands/pages/inline_query_md.rs` ignores the unknown field, so stored blocks and sync are safe. Markdown export re-encodes a `v2:` spec through that struct, though, so an exported file drops its list (a text query's `columns:a,b` is exported as written). The fix is one `#[serde(default, skip_serializing_if = "Option::is_none")] columns: Option<Vec<String>>` field. It is not made here.

## One task checkbox

- **Shared module:** `TaskCheckbox` and `TaskMarkerButton` moved to `src/components/editor/TaskMarkerButton.tsx`, and `BlockInlineControls` re-exports them.
  - The move keeps `BlockListItem` from importing the block controls' whole graph.
  - The check and X icons are drawn at render time, not at module scope.
- **Cycling:** `useTaskStateCycle` runs `set_todo_state` with `nextTaskState`, as a block click does. Lists refetch on the property event.
- **Where it shows:**
  - The Due panel's rows, through `BlockListItem`'s new `taskState`.
  - Its overdue and upcoming rows (`AlertSection`), in place of the status pill.
  - The Agenda rows (`taskState`), in place of `StatusIcon`.
- **Keys:** the button stops Enter and Space, so they toggle the task and do not also open the row.
- **Query list rows:** these draw `TaskCheckbox` but are not a control. The row is a listbox `option`, and a button inside one is axe `nested-interactive`.
- **Not changed:** DonePanel and UnfinishedTasks.

## Tag colour: not built

- **Premise held:** `color` is written with `set_property`, and an undeclared key is accepted.
- **Missing:** a read path.
  - The clean one is `list_all_tags_in_space` (`TagCacheRow`) carrying the colour, which is a Rust change.
  - The front-end one adds an IPC call to the resolve-store tag scan or to the Tags view. That trips the strict-invoke guard in the many suites that stub tags (`src/stores/__tests__/resolve.test.ts` among them) and `perf.spec.ts`'s Tags IPC pin.

## Checks

- **vitest:** query, dialogs, PageBrowser and the lib tests, `useTaskStateCycle`, agenda and BlockListItem.
- **Old assertions updated in review:** the TODO/DOING pill and status-icon tests (`AlertSection`, `OverdueSection`, `UpcomingSection`, `QueryResultList`, `AgendaResults`, `e2e/query-blocks.spec.ts`) now assert the checkbox and the state in its name; the `AgendaResults` and `DuePanel` lucide mocks gained `Check` and `X`; `e2e/enter-delete-new-user.spec.ts` scopes its checkbox to the page's blocks, as the Due panel now draws one too; `e2e/trash-badge.spec.ts` reads the count from the badge, as the button now shows its name.
- **Falsified:**
  - the new vitest and e2e tests (`readQueryColumns`, `detectColumns`' named branch, the encoder's `columns`, the decoder's string check);
  - `useTaskStateCycle`'s next state;
  - DuePanel's `taskState`;
  - the header label's `@xl:not-sr-only`.
- **Playwright:** the three new specs; `views-axe` for Pages, Journal and Advanced Query in both themes; `query-blocks`, `due-panel`, `agenda-advanced`, `agenda-sort-group`, `pages-browser-happy-paths`, `advanced-query-happy-paths`, `block-metadata-row-layout`, `task-checkbox-dot` and `enter-delete-new-user`.
